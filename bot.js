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
const AUTH_SECRET = process.env.AUTH_SECRET || "XiaoLin666"; // Lua 验证防伪密钥

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
        console.error("读取 GitHub 文件失败:", err.message);
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
        console.error("写入 GitHub 失败:", err.message);
        return false;
    }
}

// ---------------------------------------------------------
// Express 网页接口：接收 Roblox 脚本发来的设备码
// ---------------------------------------------------------
const app = express();
app.use(express.json());

app.post('/api/bind-hwid', async (req, res) => {
    const { key, hwid, secret } = req.body;

    // 检查密钥，防止坏人恶意发包
    if (secret !== AUTH_SECRET) {
        return res.status(403).json({ success: false, message: "验证密钥错误" });
    }

    if (!key || !hwid) {
        return res.status(400).json({ success: false, message: "缺少必要参数" });
    }

    const { content, sha } = await getGithubKeys();
    if (!sha) {
        return res.status(500).json({ success: false, message: "无法读取云端数据库" });
    }

    let lines = content.split(/\r?\n/);
    let keyFound = false;
    let isBound = false;
    let newLines = [];

    for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;

        let [k, boundHwid] = trimmed.split(':');
        if (k === key) {
            keyFound = true;
            if (!boundHwid || boundHwid === '') {
                // 如果这卡还没绑定设备，自动拼接当前 HWID
                newLines.push(`${key}:${hwid}`);
                isBound = true;
            } else {
                newLines.push(line);
            }
        } else {
            newLines.push(line);
        }
    }

    if (!keyFound) {
        return res.status(404).json({ success: false, message: "卡密不存在" });
    }

    if (!isBound) {
        return res.status(400).json({ success: false, message: "卡密已被其他设备占用" });
    }

    // 更新到 GitHub
    const updatedContent = newLines.join('\n');
    const updateSuccess = await updateGithubKeys(updatedContent, sha, `自动绑定卡密 [${key}] 到设备 [${hwid}]`);

    if (updateSuccess) {
        return res.json({ success: true, message: "设备绑定成功" });
    } else {
        return res.status(500).json({ success: false, message: "云端写入失败" });
    }
});

app.listen(PORT, () => {
    console.log(`绑定 API 服务已运行在端口: ${PORT}`);
});

// ---------------------------------------------------------
// Discord 指令交互
// ---------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('批量生成卡密并写入 GitHub')
        .addIntegerOption(opt => opt.setName('count').setDescription('生成卡密数量').setRequired(true)),
    new SlashCommandBuilder()
        .setName('resetkey')
        .setDescription('解绑卡密的设备码 (HWID)')
        .addStringOption(opt => opt.setName('key').setDescription('需要解绑的卡密').setRequired(true))
];

client.on('ready', async () => {
    console.log(`机器人登录成功: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Discord 指令注册完成！");
    } catch (err) {
        console.error("注册指令失败:", err);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    -- Discord 批量生成卡密命令 (/genkey 100)
    if (commandName === 'genkey') {
        await interaction.deferReply();
        const count = interaction.options.getInteger('count');
        const { content, sha } = await getGithubKeys();

        let newKeys = [];
        for (let i = 0; i < count; i++) {
            let randomCode = Math.random().toString(36).substring(2, 10).toUpperCase();
            newKeys.push(`XLKEY-${randomCode}`);
        }

        let updatedContent = content ? content + '\n' + newKeys.join('\n') : newKeys.join('\n');
        let success = await updateGithubKeys(updatedContent, sha, `批量生成 ${count} 张卡密`);

        if (success) {
            await interaction.editReply(`成功生成 **${count}** 张卡密并写入 GitHub！\n\`\`\`text\n${newKeys.join('\n')}\n\`\`\``);
        } else {
            await interaction.editReply(`生成卡密失败，请检查服务器日志。`);
        }
    }

    -- Discord 解绑卡密命令 (/resetkey XLKEY-XXXX)
    if (commandName === 'resetkey') {
        await interaction.deferReply();
        const keyToReset = interaction.options.getString('key');
        const { content, sha } = await getGithubKeys();

        let lines = content.split(/\r?\n/);
        let found = false;
        let newLines = lines.map(line => {
            let [k] = line.split(':');
            if (k === keyToReset) {
                found = true;
                return k; // 清空后面的 :HWID
            }
            return line;
        });

        if (!found) {
            return interaction.editReply(`未找到卡密 \`${keyToReset}\`！`);
        }

        let success = await updateGithubKeys(newLines.join('\n'), sha, `解绑卡密 [${keyToReset}]`);
        if (success) {
            await interaction.editReply(`卡密 \`${keyToReset}\` 已成功解绑！设备码已清空。`);
        } else {
            await interaction.editReply(`解绑失败！`);
        }
    }
});

client.login(DISCORD_TOKEN);
