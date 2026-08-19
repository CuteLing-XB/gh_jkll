const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_KEYS_PATH = process.env.GITHUB_PATH || 'keys.txt';
const GITHUB_BAN_PATH = 'blacklist.txt'; // 黑名单文件存储路径
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "XiaoLin666";

const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'KeyAuth-Bot'
};

// 通用 GitHub API 操作函数
async function getGithubFile(filePath) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    try {
        const res = await axios.get(url, { headers: githubHeaders });
        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        return { content, sha: res.data.sha };
    } catch (err) {
        if (err.response && err.response.status === 404) {
            // 文件不存在时返回空内容
            return { content: "", sha: null };
        }
        console.error(`[GitHub API] 读取 ${filePath} 失败:`, err.message);
        return { content: "", sha: null };
    }
}

async function updateGithubFile(filePath, newContent, sha, commitMessage) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    try {
        const encodedContent = Buffer.from(newContent, 'utf-8').toString('base64');
        const payload = {
            message: commitMessage,
            content: encodedContent
        };
        if (sha) payload.sha = sha;

        await axios.put(url, payload, { headers: githubHeaders });
        return true;
    } catch (err) {
        console.error(`[GitHub API] 写入 ${filePath} 失败:`, err.message);
        return false;
    }
}

// ---------------------------------------------------------
// Express 服务
// ---------------------------------------------------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send({
        status: "online",
        message: "XiaoLin Key & Ban Management Server is running!",
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).send("OK");
});

// 卡密校验与设备绑定 API
app.post('/api/bind-hwid', async (req, res) => {
    const { key, hwid, secret, username } = req.body;

    if (secret !== AUTH_SECRET) {
        return res.status(403).json({ success: false, message: "验证密钥不正确" });
    }

    // 1. 检查 Roblox 用户名是否在 GitHub 的 blacklist.txt 中
    if (username) {
        const lowerName = String(username).trim().toLowerCase();
        const { content: banContent } = await getGithubFile(GITHUB_BAN_PATH);
        
        if (banContent) {
            const bannedUsers = banContent.split(/\r?\n/).map(u => u.trim().toLowerCase());
            if (bannedUsers.includes(lowerName)) {
                return res.status(403).json({ 
                    success: false, 
                    kicked: true,
                    message: `账号 [${username}] 已被管理员拉黑封禁！` 
                });
            }
        }
    }

    if (!key || !hwid) {
        return res.status(400).json({ success: false, message: "缺少卡密或设备码参数" });
    }

    const cleanKey = String(key).trim();
    const cleanHwid = String(hwid).trim();

    // 2. 检查卡密文件
    const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
    if (!sha) {
        return res.status(500).json({ success: false, message: "无法读取云端卡密库" });
    }

    let lines = content.split(/\r?\n/);
    let keyFound = false;
    let authPassed = false;
    let needUpdateGithub = false;
    let responseMessage = "";
    let newLines = [];

    for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;

        let [k, boundHwid] = trimmed.split(':');
        k = k ? k.trim() : '';
        boundHwid = boundHwid ? boundHwid.trim() : '';

        if (k === cleanKey) {
            keyFound = true;
            if (!boundHwid || boundHwid === '') {
                newLines.push(`${cleanKey}:${cleanHwid}`);
                authPassed = true;
                needUpdateGithub = true;
                responseMessage = "首次登录，卡密已成功绑定本设备";
            } else if (boundHwid === cleanHwid) {
                newLines.push(line);
                authPassed = true;
                responseMessage = "设备匹配成功，登录通过";
            } else {
                newLines.push(line);
                authPassed = false;
                responseMessage = "卡密已被其他设备绑定！";
            }
        } else {
            newLines.push(line);
        }
    }

    if (!keyFound) {
        return res.status(404).json({ success: false, message: "卡密不存在或已被拉黑删除" });
    }

    if (!authPassed) {
        return res.status(400).json({ success: false, message: responseMessage });
    }

    if (needUpdateGithub) {
        const updatedContent = newLines.join('\n');
        const updateSuccess = await updateGithubFile(GITHUB_KEYS_PATH, updatedContent, sha, `绑定卡密 [${cleanKey}] 到设备 [${cleanHwid}]`);
        if (updateSuccess) {
            return res.json({ success: true, message: responseMessage });
        } else {
            return res.status(500).json({ success: false, message: "云端数据库写入失败" });
        }
    } else {
        return res.json({ success: true, message: responseMessage });
    }
});

app.listen(PORT, () => {
    console.log(`[API Service] 服务已在端口 ${PORT} 启动！`);
});

// ---------------------------------------------------------
// Discord 管理员指令
// ---------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    // 1. 生成卡密
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('【管理员】批量生成卡密')
        .addIntegerOption(opt => opt.setName('count').setDescription('生成卡密数量 (1-100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // 2. 解绑卡密 HWID
    new SlashCommandBuilder()
        .setName('resetkey')
        .setDescription('【管理员】解绑卡密的设备码 (HWID)')
        .addStringOption(opt => opt.setName('key').setDescription('需要解绑的卡密').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // 3. 删除/销毁卡密
    new SlashCommandBuilder()
        .setName('delkey')
        .setDescription('【管理员】彻底销毁卡密')
        .addStringOption(opt => opt.setName('key').setDescription('需要销毁的卡密').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // 4. 封禁/远程踢出 Roblox 用户名
    new SlashCommandBuilder()
        .setName('banuser')
        .setDescription('【管理员】封禁/远程踢出 Roblox 用户')
        .addStringOption(opt => opt.setName('username').setDescription('要封禁的 Roblox 用户名').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // 5. 解封 Roblox 用户名 (新增)
    new SlashCommandBuilder()
        .setName('unbanuser')
        .setDescription('【管理员】解封指定 Roblox 用户')
        .addStringOption(opt => opt.setName('username').setDescription('要解封的 Roblox 用户名').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.on('ready', async () => {
    console.log(`[Discord Bot] 登录成功: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("[Discord Bot] 斜杠指令注册完成！");
    } catch (err) {
        console.error("[Discord Bot] 注册斜杠指令失败:", err.message);
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
        if (count <= 0 || count > 100) return interaction.editReply("数量需在 1 到 100 之间！");

        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
        if (!sha) return interaction.editReply("读取云端数据库失败！");

        let newKeys = [];
        for (let i = 0; i < count; i++) {
            let randomCode = Math.random().toString(36).substring(2, 10).toUpperCase();
            newKeys.push(`XLKEY-${randomCode}`);
        }

        let updatedContent = content ? content.trim() + '\n' + newKeys.join('\n') : newKeys.join('\n');
        let success = await updateGithubFile(GITHUB_KEYS_PATH, updatedContent, sha, `批量生成 ${count} 张卡密`);

        if (success) {
            await interaction.editReply(`✅ 成功生成 **${count}** 张卡密：\n\`\`\`text\n${newKeys.join('\n')}\n\`\`\``);
        } else {
            await interaction.editReply(`❌ 写入 GitHub 失败！`);
        }
    }

    // 指令 2: /resetkey
    if (commandName === 'resetkey') {
        await interaction.deferReply({ ephemeral: true });
        const keyToReset = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
        if (!sha) return interaction.editReply("读取云端数据库失败！");

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

        if (!found) return interaction.editReply(`未找到卡密 \`${keyToReset}\`！`);

        let success = await updateGithubFile(GITHUB_KEYS_PATH, newLines.join('\n'), sha, `解绑卡密 [${keyToReset}]`);
        if (success) {
            await interaction.editReply(`✅ 卡密 \`${keyToReset}\` 已成功解绑设备！`);
        } else {
            await interaction.editReply(`❌ 解绑失败！`);
        }
    }

    // 指令 3: /delkey
    if (commandName === 'delkey') {
        await interaction.deferReply({ ephemeral: true });
        const keyToDelete = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
        if (!sha) return interaction.editReply("读取云端数据库失败！");

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

        if (!found) return interaction.editReply(`未找到需要删除的卡密 \`${keyToDelete}\`！`);

        let success = await updateGithubFile(GITHUB_KEYS_PATH, newLines.join('\n'), sha, `销毁卡密 [${keyToDelete}]`);
        if (success) {
            await interaction.editReply(`🚨 **卡密已销毁**：\`${keyToDelete}\` 已被作废！`);
        } else {
            await interaction.editReply(`❌ 删除卡密失败！`);
        }
    }

    // 指令 4: /banuser (拉黑/踢出用户)
    if (commandName === 'banuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH);

        let banList = content ? content.split(/\r?\n/).map(u => u.trim()).filter(Boolean) : [];
        if (banList.some(u => u.toLowerCase() === targetUser.toLowerCase())) {
            return interaction.editReply(`用户 \`${targetUser}\` 已经在黑名单中了！`);
        }

        banList.push(targetUser);
        let success = await updateGithubFile(GITHUB_BAN_PATH, banList.join('\n'), sha, `封禁用户 [${targetUser}]`);

        if (success) {
            await interaction.editReply(`⛔ **用户已封禁**：\`${targetUser}\` 已加入黑名单，在线将被自动踢出！`);
        } else {
            await interaction.editReply(`❌ 封禁失败！`);
        }
    }

    // 指令 5: /unbanuser (解封用户)
    if (commandName === 'unbanuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH);

        if (!content || !sha) {
            return interaction.editReply(`黑名单为空或读取失败，无需解封！`);
        }

        let banList = content.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
        let initialLength = banList.length;
        let newBanList = banList.filter(u => u.toLowerCase() !== targetUser.toLowerCase());

        if (newBanList.length === initialLength) {
            return interaction.editReply(`未在黑名单中找到用户 \`${targetUser}\`！`);
        }

        let success = await updateGithubFile(GITHUB_BAN_PATH, newBanList.join('\n'), sha, `解封用户 [${targetUser}]`);

        if (success) {
            await interaction.editReply(`✅ **用户已解封**：\`${targetUser}\` 已从黑名单中移除，可正常使用脚本！`);
        } else {
            await interaction.editReply(`❌ 解封失败！`);
        }
    }
});

client.login(DISCORD_TOKEN);
