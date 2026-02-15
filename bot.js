require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Настройка бота и ИИ
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Функция логики ИИ
async function getAIResponse(text) {
    const prompt = `Ты — агент Краб. Помогаешь владельцу сервера. Если в запросе есть задача или команда (сделай, запусти, создай), начни ответ строго с фразы EXEC_ACTION. Текст: ${text}`;
    try {
        const result = await geminiModel.generateContent(prompt);
        return { text: result.response.text(), source: 'Gemini' };
    } catch (e) {
        const res = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini",
            messages: [{role: "system", content: prompt}, {role: "user", content: text}]
        }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } });
        return { text: res.data.choices[0].message.content, source: 'GPT-Backup' };
    }
}

// Обработка сообщений
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    let userInput = msg.text;

    try {
        // Если прислали голосовое — превращаем в текст
        if (msg.voice) {
            const fileLink = await bot.getFileLink(msg.voice.file_id);
            const oggPath = `/tmp/voice_${chatId}.ogg`;
            const mp3Path = `/tmp/voice_${chatId}.mp3`;
            
            const audio = await axios({ url: fileLink, responseType: 'arraybuffer' });
            fs.writeFileSync(oggPath, Buffer.from(audio.data));
            
            // Конвертация через FFmpeg (который поставит Coolify)
            execSync(`ffmpeg -y -i ${oggPath} ${mp3Path}`);

            const form = new FormData();
            form.append('file', fs.createReadStream(mp3Path));
            form.append('model', 'whisper-1');
            
            const whisper = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
                headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
            });
            userInput = whisper.data.text;
            bot.sendMessage(chatId, `🎤 Слышу тебя: "${userInput}"`);
        }

        if (!userInput) return;

        const ai = await getAIResponse(userInput);

        // Если ИИ решил, что это команда — шлем в n8n
        if (ai.text.includes("EXEC_ACTION")) {
            await axios.post(process.env.N8N_WEBHOOK_URL, { command: userInput, chatId: chatId });
            bot.sendMessage(chatId, `🦀 [${ai.source}] Задача ушла в n8n!`);
        } else {
            bot.sendMessage(chatId, `[${ai.source}]: ${ai.text}`);
        }
    } catch (err) {
        console.error("Error:", err.message);
    }
});

console.log("🚀 Краб со всеми скиллами запущен!");
