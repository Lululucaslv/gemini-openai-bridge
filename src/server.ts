import express from 'express';
import bodyParser from 'body-parser';
import { randomUUID } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Content } from '@google/generative-ai';

const app = express();
app.use(bodyParser.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = 'gemini-2.5-pro-preview-05-06';

// GET /v1/models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'google',
      },
    ],
  });
});

// POST /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
  const {
    messages,
    stream = false,
    temperature = 0.7,
  } = req.body as {
    messages: { role: string; content: string }[];
    stream?: boolean;
    temperature?: number;
  };

  const contents: Content[] = messages.map(({ role, content }) => ({
    role: role === 'assistant' ? 'model' : (role as 'user' | 'model' | 'function'),
    parts: [{ text: content }],
  }));

  const model = genAI.getGenerativeModel({ model: MODEL_ID });

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // @ts-ignore
    res.flush?.();

    const itr = await model.generateContentStream({
      contents,
      generationConfig: { temperature },
    });

    for await (const chunk of itr.stream) {
      const token = chunk.text();
      res.write(
        `data: ${JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: MODEL_ID,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: token },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      // @ts-ignore
      res.flush?.();
    }

    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const result = await model.generateContent({
    contents,
    generationConfig: { temperature },
  });

  res.json({
    id: randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: result.response.text() },
      },
    ],
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API up on :${PORT}`);
});
