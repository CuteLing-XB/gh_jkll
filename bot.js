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

app.get('/get-key', async (req, res) => {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
    
    if (!content || !sha) {
        return res.send("<h2>Database error, please try again later.</h2>");
    }

    let lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    for (let line of lines) {
        let parts = line.split(':');
        if (parts.length >= 3 && parts[1] === 'CLAIMED' && parts[2] === clientIp) {
            return res.send(`
                <html>
                    <body style="text-align:center;padding-top:60px;font-family:sans-serif;">
                        <h2>Your Claimed Key:</h2>
                        <h1 style="color:#0051ff;user-select:all;font-size:32px;">${parts[0]}</h1>
                        <p>Each user is allowed only 1 key. Copy this key into Roblox.</p>
                    </body>
                </html>
            `);
        }
    }

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
                    <h2>All keys have been claimed!</h2>
                    <p>Please contact admin to generate more keys.</p>
                </body>
            </html>
        `);
    }

    let assignedKey = lines[unclaimedIndex];
    lines[unclaimedIndex] = `${assignedKey}:CLAIMED:${clientIp}`;

    let success = await updateGithubFile(GITHUB_KEYS_PATH, lines.join('\n'), sha, `Claim ${assignedKey} for IP ${clientIp}`);
    if (!success) {
        return res.send("<h2>System busy, please refresh and try again.</h2>");
    }

    return res.send(`
        <html>
            <body style="text-align:center;padding-top:60px;font-family:sans-serif;">
                <h2>Your Exclusive Key:</h2>
                <h1 style="color:#0051ff;user-select:all;font-size:32px;">${assignedKey}</h1>
                <p>Copy this key and paste it into Roblox. (1 key per IP)</p>
            </body>
        </html>
    `);
});

app.post('/api/bind-hwid', async (req, res) => {
    const { key, hwid, secret, username } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "Secret mismatch" });

    if (username) {
        const { content: banContent } = await getGithubFile(GITHUB_BAN_PATH);
        if (banContent) {
            const bannedUsers = banContent.split(/\r?\n/).map(u => u.trim().toLowerCase());
            if (bannedUsers.includes(String(username).trim().toLowerCase())) {
                return res.status(403).json({ success: false, kicked: true, message: "User is banned" });
            }
        }
    }

    if (!key || !hwid) return res.status(400).json({ success: false, message: "Missing parameters" });

    const cleanKey = String(key).trim();
    const cleanHwid = String(hwid).trim();

    const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
    if (!sha) return res.status(500).json({ success: false, message: "Database error" });

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
                responseMessage = "Key bound to this device successfully";
            } else if (status === cleanHwid) {
                newLines.push(line);
                authPassed = true;
                responseMessage = "Device verified successfully";
            } else {
                newLines.push(line);
                authPassed = false;
                responseMessage = "Key is already bound to another device";
            }
        } else {
            newLines.push(line);
        }
    }

    if (!keyFound) return res.status(404).json({ success: false, message: "Key not found" });
    if (!authPassed) return res.status(400).json({ success: false, message: responseMessage });

    if (needUpdateGithub) {
        const updatedContent = newLines.join('\n');
        const updateSuccess = await updateGithubFile(GITHUB_KEYS_PATH, updatedContent, sha, `Bind key ${cleanKey}`);
        if (updateSuccess) {
            return res.json({ success: true, message: responseMessage });
        } else {
            return res.status(500).json({ success: false, message: "Database write error" });
        }
    } else {
        return res.json({ success: true, message: responseMessage });
    }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('Generate keys')
        .addIntegerOption(opt => opt.setName('count').setDescription('Count 1-100').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('resetkey')
        .setDescription('Reset HWID for key')
        .addStringOption(opt => opt.setName('key').setDescription('Key').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('delkey')
        .setDescription('Delete key')
        .addStringOption(opt => opt.setName('key').setDescription('Key').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('banuser')
        .setDescription('Ban Roblox user')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox Username').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('unbanuser')
        .setDescription('Unban Roblox user')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox Username').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.on('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    } catch (err) {
        console.error("Register slash commands failed:", err);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "Admin permissions required.", ephemeral: true });
    }

    const { commandName } = interaction;

    if (commandName === 'genkey') {
        await interaction.deferReply({ ephemeral: true });
        const count = interaction.options.getInteger('count');
        if (count <= 0 || count > 100) return interaction.editReply("Count must be between 1 and 100.");

        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
        if (!sha) return interaction.editReply("Failed to fetch database.");

        let newKeys = [];
        for (let i = 0; i < count; i++) {
            let randomCode = Math.random().toString(36).substring(2, 10).toUpperCase();
            newKeys.push(`XLKEY-${randomCode}`);
        }

        let updatedContent = content ? content.trim() + '\n' + newKeys.join('\n') : newKeys.join('\n');
        let success = await updateGithubFile(GITHUB_KEYS_PATH, updatedContent, sha, `Gen ${count} keys`);

        if (success) {
            await interaction.editReply(`Generated **${count}** keys:\n\`\`\`text\n${newKeys.join('\n')}\n\`\`\``);
        } else {
            await interaction.editReply("Failed to write database.");
        }
    }

    if (commandName === 'resetkey') {
        await interaction.deferReply({ ephemeral: true });
        const keyToReset = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
        if (!sha) return interaction.editReply("Failed to fetch database.");

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

        if (!found) return interaction.editReply(`Key \`${keyToReset}\` not found.`);

        let success = await updateGithubFile(GITHUB_KEYS_PATH, newLines.join('\n'), sha, `Reset ${keyToReset}`);
        if (success) {
            await interaction.editReply(`Key \`${keyToReset}\` HWID reset successfully.`);
        } else {
            await interaction.editReply("Failed to update database.");
        }
    }

    if (commandName === 'delkey') {
        await interaction.deferReply({ ephemeral: true });
        const keyToDelete = interaction.options.getString('key').trim();
        const { content, sha } = await getGithubFile(GITHUB_KEYS_PATH);
        if (!sha) return interaction.editReply("Failed to fetch database.");

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

        if (!found) return interaction.editReply(`Key \`${keyToDelete}\` not found.`);

        let success = await updateGithubFile(GITHUB_KEYS_PATH, newLines.join('\n'), sha, `Delete ${keyToDelete}`);
        if (success) {
            await interaction.editReply(`Key \`${keyToDelete}\` deleted.`);
        } else {
            await interaction.editReply("Failed to update database.");
        }
    }

    if (commandName === 'banuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH);

        let banList = content ? content.split(/\r?\n/).map(u => u.trim()).filter(Boolean) : [];
        if (banList.some(u => u.toLowerCase() === targetUser.toLowerCase())) {
            return interaction.editReply(`User \`${targetUser}\` is already banned.`);
        }

        banList.push(targetUser);
        let success = await updateGithubFile(GITHUB_BAN_PATH, banList.join('\n'), sha, `Ban ${targetUser}`);

        if (success) {
            await interaction.editReply(`User \`${targetUser}\` has been banned.`);
        } else {
            await interaction.editReply("Failed to update banlist.");
        }
    }

    if (commandName === 'unbanuser') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getString('username').trim();
        const { content, sha } = await getGithubFile(GITHUB_BAN_PATH);

        if (!content || !sha) return interaction.editReply("Banlist is empty.");

        let banList = content.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
        let initialLength = banList.length;
        let newBanList = banList.filter(u => u.toLowerCase() !== targetUser.toLowerCase());

        if (newBanList.length === initialLength) {
            return interaction.editReply(`User \`${targetUser}\` was not found in banlist.`);
        }

        let success = await updateGithubFile(GITHUB_BAN_PATH, newBanList.join('\n'), sha, `Unban ${targetUser}`);

        if (success) {
            await interaction.editReply(`User \`${targetUser}\` unbanned successfully.`);
        } else {
            await interaction.editReply("Failed to update banlist.");
        }
    }
});

client.login(DISCORD_TOKEN);
