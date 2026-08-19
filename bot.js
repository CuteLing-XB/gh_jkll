const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_KEYS_PATH = process.env.GITHUB_PATH || 'keys.txt';
const GITHUB_BAN_PATH = 'blacklist.txt';
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "XiaoLin666";

const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'KeyAuth-Bot'
};

async function getGithubFile(filePath) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    try {
        const res = await axios.get(url, { headers: githubHeaders });
        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        return { content, sha: res.data.sha };
    } catch (err) {
        if (err.response && err.response.status === 404) return { content: "", sha: null };
        return { content: "", sha: null };
    }
}

async function updateGithubFile(filePath, newContent, sha, message) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    try {
        const encodedContent = Buffer.from(newContent, 'utf-8').toString('base64');
        const payload = { message, content: encodedContent };
        if (sha) payload.sha = sha;
        await axios.put(url, payload, { headers: githubHeaders });
        return true;
    } catch (err) {
        return false;
    }
}

const app = express();
app.set('trust proxy', true);
app.use(express.json());

app.get('/', (req, res) => res.status(200).send({ status: "online", timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.status(200).send("OK"));

// 自助领卡 API
app.get('/get-key', async (req, res) => {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
    
    if (!content || !sha) {
        return res.send("<h2 style='text-align:center;'>数据库连接失败，请联系管理员！</h2>");
    }

    let lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    // 检查此 IP 是否已经领过卡
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

    // 查找未领取的卡密
    let unclaimedIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(':')) {
            unclaimedIndex = i;
            break;
        }
    }

    if (unclaimedIndex === -1) {
        return res.send(`
            <html>
                <body style="text-align:center;padding-top:60px;font-family:sans-serif;">
                    <h2>卡密库存不足！</h2>
                    <p>所有卡密已被领完，请联系管理员补货。</p>
                </body>
            </html>
        `);
    }

    let assignedKey = lines[unclaimedIndex];
    lines[unclaimedIndex] = `${assignedKey}:CLAIMED:${clientIp}`;

    let success = await updateGithubFile(GITHUB_KEYS_PATH, lines.join('\n'), sha, `Claim ${assignedKey} for IP ${clientIp}`);
    if (!success) {
        return res.send("<h2 style='text-align:center;'>系统繁忙，请刷新页面重试！</h2>");
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

// 验证绑定 HWID API
app.post('/api/bind-hwid', async (req, res) => {
    const { key, hwid, secret, username } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "通讯密钥错误" });

    if (username) {
        const { content: banContent } = await getGithubFile(GITHUB_BAN_PATH);
        if (banContent) {
            const bannedUsers = banContent.split(/\r?\n/).map(u => u.trim().toLowerCase());
            if (bannedUsers.includes(String(username).trim().toLowerCase())) {
                return res.status(403).json({ success: false, kicked: true, message: "玩家已被管理员拉黑封禁" });
            }
        }
    }

    if (!key || !hwid) return res.status(400).json({ success: false, message: "缺少请求参数" });

    const cleanKey = String(key).trim();
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
            return res.json({ success: true, message: responseMessage });
        } else {
            return res.status(500).json({ success: false, message: "写入卡密库失败" });
        }
    } else {
        return res.json({ success: true, message: responseMessage });
    }
});

app.listen(PORT, () => console.log(`服务已成功启动，运行端口: ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('【管理员】批量生成卡密')
        .addIntegerOption(opt => opt.setName('count').setDescription('生成卡密数量 (1-100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('resetkey')
        .setDescription('【管理员】解绑卡密设备 (HWID)')
        .addStringOption(opt => opt.setName('key').setDescription('卡密').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('delkey')
        .setDescription('【管理员】作废删除卡密')
        .addStringOption(opt => opt.setName('key').setDescription('卡密').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('banuser')
        .setDescription('【管理员】拉黑/远程踢出 Roblox 玩家')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox 用户名').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('unbanuser')
        .setDescription('【管理员】解封 Roblox 玩家')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox 用户名').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.on('ready', async () => {
    console.log(`Discord 机器人已上线: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Discord 斜杠指令注册完成");
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
        if (count <= 0 || count > 100) return interaction.editReply("数量必须在 1 到 100 之间！");

        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
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
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
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
            await interaction.editReply(`✅ 卡密 \`${keyToReset}\` 的设备绑定信息已清空，可重新绑定新机器！`);
        } else {
            await interaction.editReply("❌ 更新卡密库失败！");
        }
    }

    // 指令 3: /delkey
    if (commandName === 'delkey') {
        await interaction.deferReply({ ephemeral: true });
        const keyToDelete = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
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
            await interaction.editReply(`🚨 卡密 \`${keyToDelete}\` 已被彻底作废销毁！`);
        } else {
            await interaction.editReply("❌ 更新卡密库失败！");
        }
    }

    // 指令 4: /banuser
    if (commandName === 'banuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH);

        let banList = content ? content.split(/\r?\n/).map(u => u.trim()).filter(Boolean) : [];
        if (banList.some(u => u.toLowerCase() === targetUser.toLowerCase())) {
            return interaction.editReply(`⚠️ 玩家 \`${targetUser}\` 已经在黑名单中了！`);
        }

        banList.push(targetUser);
        let success = await updateGithubFile(GITHUB_BAN_PATH, banList.join('\n'), sha, `Ban ${targetUser}`);

        if (success) {
            await interaction.editReply(`⛔ **玩家已封禁**：\`${targetUser}\` 已加入黑名单，在线将被自动踢出！`);
        } else {
            await interaction.editReply("❌ 写入黑名单失败！");
        }
    }

    // 指令 5: /unbanuser
    if (commandName === 'unbanuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH);

        if (!content || !sha) return interaction.editReply("⚠️ 黑名单为空，无需解封！");

        let banList = content.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
        let initialLength = banList.length;
        let newBanList = banList.filter(u => u.toLowerCase() !== targetUser.toLowerCase());

        if (newBanList.length === initialLength) {
            return interaction.editReply(`❌ 在黑名单中未找到玩家 \`${targetUser}\`！`);
        }

        let success = await updateGithubFile(GITHUB_BAN_PATH, newBanList.join('\n'), sha, `Unban ${targetUser}`);

        if (success) {
            await interaction.editReply(`✅ **玩家已解封**：\`${targetUser}\` 已从黑名单中移除，可正常使用脚本！`);
        } else {
            await interaction.editReply("❌ 解封更新失败！");
        }
    }
});

client.login(DISCORD_TOKEN);
