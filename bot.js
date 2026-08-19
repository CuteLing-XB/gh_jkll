const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// =========================================================
// 环境变量配置
// =========================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_KEYS_PATH = process.env.GITHUB_PATH || 'keys.txt';
const GITHUB_BAN_PATH = 'blacklist.txt';
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "XiaoLin666";

// 管理员专属卡密白名单
const ADMIN_KEYS = ["LNMKG-917813", "XQWTU-78918888", "XLKEY-ADMIN888", "XLKEY-ADMIN999", "XiaoLinAdmin666"];

// 内存中实时记录所有正在运行脚本的玩家: Map<RobloxUsername, { lastSeen: timestamp, key: string, hwid: string, isAdmin: boolean }>
const activeScriptUsers = new Map();

// 请求 GitHub API 的标准请求头
const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'KeyAuth-Bot'
};

// =========================================================
// GitHub 读写工具函数（具备重试 + 缓存降级机制）
// =========================================================
let keyCache = { content: "", sha: null, lastFetch: 0 };
let banCache = { content: "", sha: null, lastFetch: 0 };

// 读取 GitHub 文件，包含 15s 内存缓存与 3 次重试降级策略
async function getGithubFile(filePath, forceRefresh = false) {
    const isBanPath = (filePath === GITHUB_BAN_PATH);
    const targetCache = isBanPath ? banCache : keyCache;
    const now = Date.now();

    // 15 秒内直接读取内存缓存，极大减轻 GitHub API 访问频次
    if (!forceRefresh && targetCache.sha && (now - targetCache.lastFetch < 15000)) {
        return { content: targetCache.content, sha: targetCache.sha };
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    
    // 自动重试循环：发生网络抖动或限流时尝试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await axios.get(url, { headers: githubHeaders, timeout: 5000 });
            const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
            const sha = res.data.sha;

            if (isBanPath) {
                banCache = { content, sha, lastFetch: now };
            } else {
                keyCache = { content, sha, lastFetch: now };
            }
            return { content, sha };
        } catch (err) {
            console.warn(`[GitHub API] 读取 ${filePath} 第 ${attempt} 次失败: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
        }
    }

    // 降级策略：如果 3 次尝试均失败，保底返回缓存中的内容，避免引发系统崩溃
    if (targetCache.sha) {
        console.log(`[降级保护] 读取 GitHub 超时，自动降级切换至内存缓存: ${filePath}`);
        return { content: targetCache.content, sha: targetCache.sha };
    }

    return { content: "", sha: null };
}

// 更新 GitHub 文件并在成功后同步刷新本地缓存
async function updateGithubFile(filePath, newContent, sha, message) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    try {
        const encodedContent = Buffer.from(newContent, 'utf-8').toString('base64');
        const payload = { message, content: encodedContent };
        if (sha) payload.sha = sha;

        const res = await axios.put(url, payload, { headers: githubHeaders, timeout: 8000 });
        const newSha = res.data?.content?.sha || sha;

        // 同步更新本地缓存
        const isBanPath = (filePath === GITHUB_BAN_PATH);
        if (isBanPath) {
            banCache = { content: newContent, sha: newSha, lastFetch: Date.now() };
        } else {
            keyCache = { content: newContent, sha: newSha, lastFetch: Date.now() };
        }
        return true;
    } catch (err) {
        console.error("写入 GitHub 失败:", err.message);
        return false;
    }
}

// =========================================================
// Express Web API 路由配置
// =========================================================
const app = express();
app.set('trust proxy', true);
app.use(express.json());

// 首页与心跳健康检查（供 cron-job.org / UptimeRobot 访问保活）
app.get('/', (req, res) => {
    res.status(200).send({ status: "online", timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.status(200).send("OK");
});

// 1. 自助领卡 API (网页 /get-key)
app.get('/get-key', async (req, res) => {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH, true);
    
    if (!content || !sha) {
        return res.send("<h2 style='text-align:center;'>数据库连接失败，请联系管理员！</h2>");
    }

    let lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    // 校验 IP 是否重复领卡
    for (let line of lines) {
        let parts = line.split(':');
        if (parts.length >= 3 && parts[1] === 'CLAIMED' && parts[2] === clientIp) {
            return res.send(`
                <html>
                    <body style="text-align:center;padding-top:60px;font-family:sans-serif;">
                        <h2>您已领取过卡密：</h2>
                        <h1 style="color:#0051ff;user-select:all;font-size:32px;">${parts[0]}</h1>
                        <p>一机一卡制，复制此卡密前往游戏中使用即可。</p>
                    </body>
                </html>
            `);
        }
    }

    // 寻找未分配卡密
    let unclaimedIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(':')) {
            unclaimedIndex = i;
            break;
        }
    }

    if (unclaimedIndex === -1) {
        return res.send("<h2 style='text-align:center;'>卡密库存不足！请联系管理员补货。</h2>");
    }

    let assignedKey = lines[unclaimedIndex];
    lines[unclaimedIndex] = `${assignedKey}:CLAIMED:${clientIp}`;

    let success = await updateGithubFile(GITHUB_KEYS_PATH, lines.join('\n'), sha, `Claim ${assignedKey} for IP ${clientIp}`);
    if (!success) {
        return res.send("<h2 style='text-align:center;'>系统繁忙，请刷新重试！</h2>");
    }

    return res.send(`
        <html>
            <body style="text-align:center;padding-top:60px;font-family:sans-serif;">
                <h2>您的专属卡密：</h2>
                <h1 style="color:#0051ff;user-select:all;font-size:32px;">${assignedKey}</h1>
                <p>复制此卡密并粘贴到 Roblox 脚本中。（每个 IP 限制一张）</p>
            </body>
        </html>
    `);
});

// 2. 客户端 HWID 绑定与心跳比对 API (/api/bind-hwid)
app.post('/api/bind-hwid', async (req, res) => {
    const { key, hwid, secret, username } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "通讯密钥错误" });

    const cleanKey = String(key || '').trim();
    const cleanUsername = String(username || '').trim();

    // 管理员卡密白名单无缝放行
    if (ADMIN_KEYS.includes(cleanKey)) {
        if (cleanUsername) {
            activeScriptUsers.set(cleanUsername, { lastSeen: Date.now(), key: cleanKey, hwid: hwid, isAdmin: true });
        }
        return res.json({ success: true, isAdmin: true, message: "管理员验证通过！" });
    }

    // 普通玩家黑名单核验
    if (cleanUsername) {
        const { content: banContent } = await getGithubFile(GITHUB_BAN_PATH);
        if (banContent) {
            const bannedUsers = banContent.split(/\r?\n/).map(u => u.trim().toLowerCase()).filter(Boolean);
            if (bannedUsers.includes(cleanUsername.toLowerCase())) {
                activeScriptUsers.delete(cleanUsername);
                return res.status(403).json({ success: false, kicked: true, message: "该账号已被列入黑名单" });
            }
        }
        // 刷新玩家在线心跳数据
        activeScriptUsers.set(cleanUsername, { lastSeen: Date.now(), key: cleanKey, hwid: hwid, isAdmin: false });
    }

    if (!cleanKey || !hwid) return res.status(400).json({ success: false, message: "缺少请求参数" });

    const cleanHwid = String(hwid).trim();
    const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
    if (!sha) return res.status(500).json({ success: false, message: "读取卡密库失败" });

    let lines = content.split(/\r?\n/);
    let keyFound = false;
    let authPassed = false;
    let needUpdateGithub = false;
    let responseMessage = "";
    let newLines = [];

    for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;

        let parts = trimmed.split(':');
        let k = parts[0] ? parts[0].trim() : '';
        let status = parts[1] ? parts[1].trim() : '';

        if (k === cleanKey) {
            keyFound = true;
            if (!status || status === '' || status === 'CLAIMED') {
                newLines.push(`${cleanKey}:${cleanHwid}`);
                authPassed = true;
                needUpdateGithub = true;
                responseMessage = "首次登录，成功绑定本机";
            } else if (status === cleanHwid) {
                newLines.push(line);
                authPassed = true;
                responseMessage = "设备匹配成功";
            } else {
                newLines.push(line);
                authPassed = false;
                responseMessage = "卡密已被其他设备绑定";
            }
        } else {
            newLines.push(line);
        }
    }

    if (!keyFound) return res.status(404).json({ success: false, message: "卡密不存在或已被删除" });
    if (!authPassed) return res.status(400).json({ success: false, message: responseMessage });

    if (needUpdateGithub) {
        const updatedContent = newLines.join('\n');
        const updateSuccess = await updateGithubFile(GITHUB_KEYS_PATH, updatedContent, sha, `Bind key ${cleanKey}`);
        if (updateSuccess) {
            return res.json({ success: true, isAdmin: false, message: responseMessage });
        } else {
            return res.status(500).json({ success: false, message: "写入卡密库失败" });
        }
    } else {
        return res.json({ success: true, isAdmin: false, message: responseMessage });
    }
});

// 3. 获取当前在线挂脚本玩家 API (/api/online-users)
app.get('/api/online-users', (req, res) => {
    const now = Date.now();
    const onlineUsers = [];

    activeScriptUsers.forEach((data, username) => {
        // 45 秒内没有心跳自动判定离线
        if (now - data.lastSeen < 45000) {
            onlineUsers.push(username);
        } else {
            activeScriptUsers.delete(username);
        }
    });

    res.json({ success: true, users: onlineUsers });
});

// 4. 获取黑名单玩家 API (/api/banned-users)
app.get('/api/banned-users', async (req, res) => {
    const { content } = await getGithubFile(GITHUB_BAN_PATH);
    let bannedList = content ? content.split(/\r?\n/).map(u => u.trim()).filter(Boolean) : [];
    res.json({ success: true, users: bannedList });
});

// 5. 客户端管理员远程 Kick 踢人 API (/api/admin-kick)
app.post('/api/admin-kick', async (req, res) => {
    const { adminKey, targetUser, secret } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "未授权访问" });

    const cleanAdminKey = String(adminKey || '').trim();
    if (!ADMIN_KEYS.includes(cleanAdminKey)) {
        return res.status(403).json({ success: false, message: "非管理员卡密，无权操作！" });
    }

    if (!targetUser) return res.status(400).json({ success: false, message: "请指定要踢出的目标 Roblox Username！" });

    const cleanTarget = String(targetUser).trim();

    const { content, sha } = await getGithubFile(GITHUB_BAN_PATH, true);
    let banList = content ? content.split(/\r?\n/).map(u => u.trim()).filter(Boolean) : [];

    if (!banList.some(u => u.toLowerCase() === cleanTarget.toLowerCase())) {
        banList.push(cleanTarget);
    }

    activeScriptUsers.delete(cleanTarget);

    let success = await updateGithubFile(GITHUB_BAN_PATH, banList.join('\n'), sha, `Admin Kick ${cleanTarget}`);
    if (success) {
        return res.json({ success: true, message: `已成功强行踢出并拉黑: [${cleanTarget}]` });
    } else {
        return res.status(500).json({ success: false, message: "写入黑名单失败" });
    }
});

// 6. 客户端管理员远程 Unban 解封 API (/api/admin-unban)
app.post('/api/admin-unban', async (req, res) => {
    const { adminKey, targetUser, secret } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "未授权访问" });

    const cleanAdminKey = String(adminKey || '').trim();
    if (!ADMIN_KEYS.includes(cleanAdminKey)) {
        return res.status(403).json({ success: false, message: "非管理员卡密，无权操作！" });
    }

    if (!targetUser) return res.status(400).json({ success: false, message: "请指定要解封的目标 Roblox Username！" });

    const cleanTarget = String(targetUser).trim();

    const { content, sha } = await getGithubFile(GITHUB_BAN_PATH, true);
    if (!content || !sha) return res.json({ success: true, message: "黑名单为空，无需解封！" });

    let banList = content.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
    let initialLen = banList.length;
    let newBanList = banList.filter(u => u.toLowerCase() !== cleanTarget.toLowerCase());

    if (newBanList.length === initialLen) {
        return res.status(404).json({ success: false, message: `黑名单中未找到玩家 [${cleanTarget}]` });
    }

    let success = await updateGithubFile(GITHUB_BAN_PATH, newBanList.join('\n'), sha, `Admin Unban ${cleanTarget}`);
    if (success) {
        return res.json({ success: true, message: `已成功解封玩家: [${cleanTarget}]` });
    } else {
        return res.status(500).json({ success: false, message: "更新黑名单文件失败" });
    }
});

// 监听指定端口
app.listen(PORT, () => console.log(`服务在端口 ${PORT} 上正常运行`));

// =========================================================
// Discord 机器人逻辑控制 (斜杠指令)
// =========================================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('【管理员】批量生成卡密')
        .addIntegerOption(opt => opt.setName('count').setDescription('生成数量 (1-100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('resetkey')
        .setDescription('【管理员】重置卡密绑定设备 (HWID)')
        .addStringOption(opt => opt.setName('key').setDescription('卡密').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('delkey')
        .setDescription('【管理员】删除/作废指定卡密')
        .addStringOption(opt => opt.setName('key').setDescription('卡密').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('banuser')
        .setDescription('【管理员】拉黑 Roblox 用户名')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox 用户名').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('unbanuser')
        .setDescription('【管理员】解封 Roblox 用户名')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox 用户名').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.on('ready', async () => {
    console.log(`Discord 机器人已上线: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Discord 斜杠指令注册完成！");
    } catch (err) {
        console.error("注册斜杠指令失败:", err);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "❌ 只有管理员才有权限使用此指令！", ephemeral: true });
    }

    const { commandName } = interaction;

    // 指令 1: /genkey
    if (commandName === 'genkey') {
        await interaction.deferReply({ ephemeral: true });
        const count = interaction.options.getInteger('count');
        if (count <= 0 || count > 100) return interaction.editReply("生成数量必须在 1 到 100 之间！");

        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH, true);
        if (!sha) return interaction.editReply("❌ 读取云端卡密库失败！");

        let newKeys = [];
        for (let i = 0; i < count; i++) {
            let randomCode = Math.random().toString(36).substring(2, 10).toUpperCase();
            newKeys.push(`XLKEY-${randomCode}`);
        }

        let updatedContent = content ? content.trim() + '\n' + newKeys.join('\n') : newKeys.join('\n');
        let success = await updateGithubFile(GITHUB_KEYS_PATH, updatedContent, sha, `Gen ${count} keys`);

        if (success) {
            await interaction.editReply(`✅ 成功生成 **${count}** 张卡密：\n\`\`\`text\n${newKeys.join('\n')}\n\`\`\``);
        } else {
            await interaction.editReply("❌ 写入云端卡密库失败！");
        }
    }

    // 指令 2: /resetkey
    if (commandName === 'resetkey') {
        await interaction.deferReply({ ephemeral: true });
        const keyToReset = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH, true);
        if (!sha) return interaction.editReply("❌ 读取云端卡密库失败！");

        let lines = content.split(/\r?\n/);
        let found = false;
        let newLines = lines.map(line => {
            let [k] = line.split(':');
            if (k && k.trim() === keyToReset) {
                found = true;
                return k.trim();
            }
            return line;
        });

        if (!found) return interaction.editReply(`❌ 未找到卡密 \`${keyToReset}\`！`);

        let success = await updateGithubFile(GITHUB_KEYS_PATH, newLines.join('\n'), sha, `Reset ${keyToReset}`);
        if (success) {
            await interaction.editReply(`✅ 卡密 \`${keyToReset}\` HWID 设备绑定已重置！`);
        } else {
            await interaction.editReply("❌ 更新卡密库失败！");
        }
    }

    // 指令 3: /delkey
    if (commandName === 'delkey') {
        await interaction.deferReply({ ephemeral: true });
        const keyToDelete = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH, true);
        if (!sha) return interaction.editReply("❌ 读取云端卡密库失败！");

        let lines = content.split(/\r?\n/);
        let found = false;
        let newLines = [];

        for (let line of lines) {
            let [k] = line.split(':');
            if (k && k.trim() === keyToDelete) {
                found = true;
            } else if (line.trim()) {
                newLines.push(line);
            }
        }

        if (!found) return interaction.editReply(`❌ 未找到卡密 \`${keyToDelete}\`！`);

        let success = await updateGithubFile(GITHUB_KEYS_PATH, newLines.join('\n'), sha, `Delete ${keyToDelete}`);
        if (success) {
            await interaction.editReply(`🚨 卡密 \`${keyToDelete}\` 已作废删除！`);
        } else {
            await interaction.editReply("❌ 更新卡密库失败！");
        }
    }

    // 指令 4: /banuser
    if (commandName === 'banuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH, true);

        let banList = content ? content.split(/\r?\n/).map(u => u.trim()).filter(Boolean) : [];
        if (banList.some(u => u.toLowerCase() === targetUser.toLowerCase())) {
            return interaction.editReply(`⚠️ 玩家 \`${targetUser}\` 已在黑名单中！`);
        }

        banList.push(targetUser);
        let success = await updateGithubFile(GITHUB_BAN_PATH, banList.join('\n'), sha, `Ban ${targetUser}`);

        if (success) {
            await interaction.editReply(`⛔ 玩家 \`${targetUser}\` 已拉黑！系统将在几秒内将其剔除断线。`);
        } else {
            await interaction.editReply("❌ 写入黑名单失败！");
        }
    }

    // 指令 5: /unbanuser
    if (commandName === 'unbanuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH, true);

        if (!content || !sha) return interaction.editReply("⚠️ 黑名单为空！");

        let banList = content.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
        let initialLen = banList.length;
        let newBanList = banList.filter(u => u.toLowerCase() !== targetUser.toLowerCase());

        if (newBanList.length === initialLen) {
            return interaction.editReply(`❌ 黑名单中未找到玩家 \`${targetUser}\`！`);
        }

        let success = await updateGithubFile(GITHUB_BAN_PATH, newBanList.join('\n'), sha, `Unban ${targetUser}`);

        if (success) {
            await interaction.editReply(`✅ 玩家 \`${targetUser}\` 已解封！可重新进入使用脚本。`);
        } else {
            await interaction.editReply("❌ 更新黑名单失败！");
        }
    }
});

client.login(DISCORD_TOKEN);
