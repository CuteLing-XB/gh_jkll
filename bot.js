const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// 从环境变量读取配置
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_PATH = process.env.GITHUB_PATH || 'keys.txt';
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "XiaoLin666";

const githubApiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'KeyAuth-Bot'
};

// 1. 读取 GitHub 上的 keys.txt
async function getGithubKeys() {
    try {
        const res = await axios.get(githubApiUrl, { headers: githubHeaders });
        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        return { content, sha: res.data.sha };
    } catch (err) {
        console.error("[GitHub API Error] 读取云端数据库失败:", err.message);
        return { content: "", sha: null };
    }
}

// 2. 自动写回 GitHub keys.txt
async function updateGithubKeys(newContent, sha, commitMessage) {
    try {
        const encodedContent = Buffer.from(newContent, 'utf-8').toString('base64');
        await axios.put(githubApiUrl, {
            message: commitMessage,
            content: encodedContent,
            sha: sha
        }, { headers: githubHeaders });
        return true;
    } catch (err) {
        console.error("[GitHub API Error] 写入云端数据库失败:", err.message);
        return false;
    }
}

// ---------------------------------------------------------
// Express 服务配置（支持 UptimeRobot 保活 + 卡密验证 API）
// ---------------------------------------------------------
const app = express();
app.use(express.json());

// 【新增】根路径保活健康检查（访问此页面显示状态，UptimeRobot 不会再报 404）
app.get('/', (req, res) => {
    res.status(200).send({
        status: "online",
        message: "XiaoLin Key System Server is running normally!",
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).send("OK");
});

// 卡密设备绑定与校验 API
app.post('/api/bind-hwid', async (req, res) => {
    const { key, hwid, secret } = req.body;

    // 1. 密钥校验（防非授权请求）
    if (secret !== AUTH_SECRET) {
        return res.status(403).json({ success: false, message: "验证密钥不正确" });
    }

    if (!key || !hwid) {
        return res.status(400).json({ success: false, message: "参数不完整（缺少卡密或设备码）" });
    }

    const cleanKey = String(key).trim();
    const cleanHwid = String(hwid).trim();

    // 2. 获取 GitHub 数据
    const { content, sha } = await getGithubKeys();
    if (!sha) {
        return res.status(500).json({ success: false, message: "无法读取云端数据库" });
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
            
            // 情况 A：卡密存在且未绑定设备 -> 立即绑定当前 HWID
            if (!boundHwid || boundHwid === '') {
                newLines.push(`${cleanKey}:${cleanHwid}`);
                authPassed = true;
                needUpdateGithub = true;
                responseMessage = "首次登录，卡密已成功绑定本设备";
            } 
            // 情况 B：卡密已绑定，且设备 HWID 一致 -> 允许登录
            else if (boundHwid === cleanHwid) {
                newLines.push(line);
                authPassed = true;
                responseMessage = "设备匹配成功，登录通过";
            } 
            // 情况 C：卡密已被其他设备绑定 -> 拒绝登录
            else {
                newLines.push(line);
                authPassed = false;
                responseMessage = "卡密已被其他设备绑定！如需更换设备请联系管理员解绑";
            }
        } else {
            newLines.push(line);
        }
    }

    if (!keyFound) {
        return res.status(404).json({ success: false, message: "输入的卡密不存在" });
    }

    if (!authPassed) {
        return res.status(400).json({ success: false, message: responseMessage });
    }

    // 如果需要写入 GitHub（首次绑定）
    if (needUpdateGithub) {
        const updatedContent = newLines.join('\n');
        const updateSuccess = await updateGithubKeys(updatedContent, sha, `绑定卡密 [${cleanKey}] 到设备 [${cleanHwid}]`);

        if (updateSuccess) {
            return res.json({ success: true, message: responseMessage });
        } else {
            return res.status(500).json({ success: false, message: "云端数据库写入失败，请重试" });
        }
    } else {
        // 已匹配且无需写文件，直接通过
        return res.json({ success: true, message: responseMessage });
    }
});

app.listen(PORT, () => {
    console.log(`[API Service] 服务已在端口 ${PORT} 启动！`);
});

// ---------------------------------------------------------
// Discord 指令交互逻辑
// ---------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('批量生成卡密并写入云端数据库')
        .addIntegerOption(opt => opt.setName('count').setDescription('生成卡密数量 (1-100)').setRequired(true)),
    new SlashCommandBuilder()
        .setName('resetkey')
        .setDescription('解绑卡密的设备码 (HWID)')
        .addStringOption(opt => opt.setName('key').setDescription('需要解绑的卡密').setRequired(true))
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

    const { commandName } = interaction;

    // 1. 生成卡密指令 (/genkey)
    if (commandName === 'genkey') {
        await interaction.deferReply({ ephemeral: true }); // 设置为仅执行者可见，保护隐私

        const count = interaction.options.getInteger('count');
        if (count <= 0 || count > 100) {
            return interaction.editReply("一次最多只能生成 1 到 100 张卡密！");
        }

        const { content, sha } = await getGithubKeys();
        if (!sha) {
            return interaction.editReply("读取云端数据库失败，请检查服务器网络或凭证设置。");
        }

        let newKeys = [];
        for (let i = 0; i < count; i++) {
            let randomCode = Math.random().toString(36).substring(2, 10).toUpperCase();
            newKeys.push(`XLKEY-${randomCode}`);
        }

        let updatedContent = content ? content.trim() + '\n' + newKeys.join('\n') : newKeys.join('\n');
        let success = await updateGithubKeys(updatedContent, sha, `批量生成 ${count} 张卡密`);

        if (success) {
            await interaction.editReply(`成功生成 **${count}** 张卡密并存入云端！\n\`\`\`text\n${newKeys.join('\n')}\n\`\`\``);
        } else {
            await interaction.editReply(`写入 GitHub 失败，请检查后台日志。`);
        }
    }

    // 2. 解绑卡密指令 (/resetkey)
    if (commandName === 'resetkey') {
        await interaction.deferReply({ ephemeral: true }); // 设置为仅执行者可见

        const keyToReset = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubKeys();

        if (!sha) {
            return interaction.editReply("读取云端数据库失败！");
        }

        let lines = content.split(/\r?\n/);
        let found = false;
        let newLines = lines.map(line => {
            let [k] = line.split(':');
            if (k && k.trim() === keyToReset) {
                found = true;
                return k.trim(); // 移除后半段的 :HWID
            }
            return line;
        });

        if (!found) {
            return interaction.editReply(`未找到卡密 \`${keyToReset}\`！`);
        }

        let success = await updateGithubKeys(newLines.join('\n'), sha, `解绑卡密 [${keyToReset}]`);
        if (success) {
            await interaction.editReply(`卡密 \`${keyToReset}\` 已成功解绑！绑定的设备码已被置空。`);
        } else {
            await interaction.editReply(`解绑失败，请重试！`);
        }
    }
});

client.login(DISCORD_TOKEN);
