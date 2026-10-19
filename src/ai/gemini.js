import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

let ai = null;

// Map of chatId -> Array of { role: 'user' | 'model', parts: [{ text }] }
const chatHistories = new Map();
const MAX_HISTORY_TURNS = 10; // Last 10 messages (5 turns)

export function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!ai) {
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

/**
 * Ask Gemini a question with conversation memory per chat
 */
export async function askGemini(prompt, chatId = 'default', context = '') {
  const client = getGeminiClient();
  if (!client) {
    return (
      '⚠️ *Gemini AI is not configured yet!*\n' +
      '👉 Add `GEMINI_API_KEY=your_key` to your `.env` file.'
    );
  }

  const systemInstruction =
    'You are a smart, encouraging, and clear college study assistant in a student WhatsApp group. ' +
    'Help students understand their subjects (like Data Structures, Artificial Intelligence, Logic, etc.), write and debug code, and explain complex lab questions simply. ' +
    'You remember previous messages in the conversation, so you can handle follow-up questions seamlessly. ' +
    'Format all answers strictly for WhatsApp: use *bold* for emphasis, bullets for lists, and ```code blocks``` for programming snippets. Keep explanations concise, clear, and direct.';

  try {
    let history = chatHistories.get(chatId) || [];

    const userMessageText = context
      ? `[Classroom Material / Announcement Context]:\n${context}\n\n[Student Question]:\n${prompt}`
      : prompt;

    const contents = [
      ...history,
      {
        role: 'user',
        parts: [{ text: userMessageText }]
      }
    ];

    const response = await client.models.generateContent({
      model: 'gemini-3.8-flash',
      contents,
      config: {
        systemInstruction
      }
    });

    const replyText = response.text?.trim() || 'No response generated.';

    // Retain conversation memory for this chat
    history.push({ role: 'user', parts: [{ text: prompt }] });
    history.push({ role: 'model', parts: [{ text: replyText }] });

    // Prune history to avoid token bloat
    if (history.length > MAX_HISTORY_TURNS) {
      history = history.slice(-MAX_HISTORY_TURNS);
    }
    chatHistories.set(chatId, history);

    return replyText;
  } catch (err) {
    console.error('Gemini API Error:', err);
    return `❌ *Gemini Error:* ${err.message}`;
  }
}

/**
 * Clear conversation memory for a chat
 */
export function clearChatHistory(chatId) {
  chatHistories.delete(chatId);
}
