import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

let ai = null;

export function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!ai) {
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

/**
 * Ask Gemini a question
 */
export async function askGemini(prompt, context = '') {
  const client = getGeminiClient();
  if (!client) {
    return (
      '⚠️ *Gemini AI is not configured yet!*\n' +
      '👉 Get a free API key at: https://aistudio.google.com/app/apikey\n' +
      '👉 Add `GEMINI_API_KEY=your_key` to your `.env` file in the bot folder.'
    );
  }

  const systemInstruction =
    'You are a smart, encouraging, and clear college study assistant in a student WhatsApp group. ' +
    'Help students understand their subjects (like Data Structures, Artificial Intelligence, Logic, etc.), write and debug code, and explain complex lab questions simply. ' +
    'Format all answers strictly for WhatsApp: use *bold* for emphasis, bullets for lists, and ```code blocks``` for programming snippets. Keep explanations concise, clear, and direct.';

  try {
    const fullPrompt = context
      ? `[Classroom Material / Announcement Context]:\n${context}\n\n[Student Question]:\n${prompt}`
      : prompt;

    const response = await client.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: fullPrompt,
      config: {
        systemInstruction
      }
    });

    return response.text?.trim() || 'No response generated.';
  } catch (err) {
    console.error('Gemini API Error:', err);
    return `❌ *Gemini Error:* ${err.message}`;
  }
}
