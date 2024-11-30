const { Client, GatewayIntentBits, Events, ApplicationCommandType } = require('discord.js');
const { exec } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { token } = require('./config');

// Загрузка локализаций
const loadLocales = () => {
    const locales = {};
    const files = fs.readdirSync(path.join(__dirname, 'locales'));
    for (const file of files) {
        if (file.endsWith('.json')) {
            const localeName = path.basename(file, '.json');
            locales[localeName] = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', file), 'utf8'));
        }
    }
    return locales;
};

const locales = loadLocales();

// Получение локализации пользователя
const getUserLocale = (interaction) => {
    const locale = interaction.locale.split('-')[0]; // Например: "ru-RU" -> "ru"
    return locales[locale] || locales['en']; // Если язык отсутствует, используем английский
};

// Создаем клиента Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
});

// Логирование ошибок
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Регистрация команд (сокращена для примера)
    const commands = [
        {
            name: 'fix',
            description: 'Download and convert video from a URL',
            options: [
                {
                    name: 'url',
                    type: 3, // STRING
                    description: 'URL of the video or message with the video',
                    required: true,
                },
            ],
        },
        {
            name: 'Fix Video',
            type: ApplicationCommandType.Message,
        },
        {
            name: 'fix_dm',
            description: 'Download and convert video, sending the result to DMs',
            options: [
                {
                    name: 'url',
                    type: 3, // STRING
                    description: 'URL of the video or message with the video',
                    required: true,
                },
            ],
        },
        {
            name: 'Fix DM',
            type: ApplicationCommandType.Message,
        },
    ];
    console.log('Registering commands...');
    await client.application.commands.set(commands);
    console.log('Commands registered.');
});

// Функция для скачивания видео
async function downloadVideo(url, filename) {
    const response = await axios({ method: 'GET', url, responseType: 'stream' });
    const writer = fs.createWriteStream(filename);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Функция для проверки аппаратного ускорения
async function checkHardwareAcceleration() {
    return new Promise((resolve, reject) => {
        exec(`${ffmpegPath} -hwaccels`, (error, stdout) => {
            if (error) {
                reject(new Error('Error checking hardware acceleration.'));
                return;
            }
            if (stdout.includes('cuda') || stdout.includes('nvenc')) {
                resolve('nvenc');
            } else if (stdout.includes('qsv')) {
                resolve('qsv');
            } else if (stdout.includes('vce')) {
                resolve('vce');
            } else {
                resolve(null);
            }
        });
    });
}

// Функция для конвертации видео
async function convertVideo(input, output) {
    console.log(`Starting conversion: ${input} -> ${output}`);
    try {
        const hardwareAccel = await checkHardwareAcceleration();
        let command = `${ffmpegPath} -i "${input}" -threads 1 "${output}"`;
        if (hardwareAccel === 'nvenc') {
            command = `${ffmpegPath} -i "${input}" -c:v h264_nvenc -threads 1 "${output}"`;
        } else if (hardwareAccel === 'qsv') {
            command = `${ffmpegPath} -i "${input}" -c:v h264_qsv -threads 1 "${output}"`;
        } else if (hardwareAccel === 'vce') {
            command = `${ffmpegPath} -i "${input}" -c:v h264_amf -threads 1 "${output}"`;
        }
        return new Promise((resolve, reject) => {
            exec(command, (error) => {
                if (error) {
                    console.error('Conversion failed:', error);
                    reject(new Error('Failed to convert video.'));
                    return;
                }
                console.log(`Conversion successful: ${output}`);
                resolve();
            });
        });
    } catch (error) {
        console.error('Error during conversion:', error);
    }
}

// Функция для обработки видео
async function processVideo(interaction, url, tempDir, sendDM = false) {
    const locale = getUserLocale(interaction);
    const inputFile = path.join(tempDir, `${interaction.id}-input.mp4`);
    const outputFile = path.join(tempDir, `${interaction.id}-output.mp4`);

    try {
        await interaction.editReply({ content: locale['downloading_video'] });
        await downloadVideo(url, inputFile);

        await interaction.editReply({ content: locale['converting_video'] });
        await convertVideo(inputFile, outputFile);

        if (sendDM) {
            await interaction.editReply({ content: locale['video_sent_dm'] });
            await interaction.user.send({ content: locale['video_converted'], files: [outputFile] });
        } else {
            await interaction.editReply({ content: locale['video_converted'], files: [outputFile] });
        }
    } catch (error) {
        await interaction.followUp({
            content: locale['error_occurred'].replace('{error}', error.message),
            ephemeral: true,
        });
    } finally {
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    }
}

// Обработчик взаимодействий
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isCommand() && !interaction.isMessageContextMenuCommand()) return;

    const locale = getUserLocale(interaction);
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    await interaction.reply({ content: locale['processing_request'], ephemeral: true });

    if (interaction.commandName === 'fix' || interaction.commandName === 'fix_dm') {
        const url = interaction.options.getString('url');
        if (url) {
            await processVideo(interaction, url, tempDir, interaction.commandName === 'fix_dm');
        } else {
            await interaction.followUp({ content: locale['no_url_provided'], ephemeral: true });
        }
    } else if (interaction.commandName === 'Fix Video' || interaction.commandName === 'Fix DM') {
        const sendDM = interaction.commandName === 'Fix DM';
        const targetMessage = interaction.targetMessage;
        try {
            const referencedMessage = targetMessage.reference
                ? await targetMessage.fetchReference()
                : targetMessage;

            const videoAttachment = referencedMessage.attachments?.find(attachment =>
                attachment.contentType?.startsWith('video/')
            );

            if (videoAttachment) {
                await processVideo(interaction, videoAttachment.url, tempDir, sendDM);
            } else {
                const videoUrlRegex = /https:\/\/cdn\.discordapp\.com\/attachments\/[\w-]+\/[\w-]+\/[\w-]+\.mp4(\?.*)?/;
                const match = referencedMessage.content?.match(videoUrlRegex);
                if (match) {
                    await processVideo(interaction, match[0], tempDir, sendDM);
                } else {
                    await interaction.followUp({ content: locale['no_video_found'], ephemeral: true });
                }
            }
        } catch (error) {
            await interaction.followUp({ content: locale['error_occurred'].replace('{error}', error.message), ephemeral: true });
        }
    }
});

// Логин клиента
client.login(token);
