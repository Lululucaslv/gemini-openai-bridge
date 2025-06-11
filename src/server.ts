import express from 'express';
import { randomUUID } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Content, GenerativeModel } from '@google/generative-ai';
import type { Request, Response } from 'express';

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = 'models/gemini-2.5-pro-preview-05-06';
const model: GenerativeModel = genAI.getGenerativeModel({ model: MODEL_ID });

// GET /v1/models
app.get('/v1/models', (req: Request, res: Response) => {
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
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  try {
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

    if (stream) {
      const requestId = randomUUID();
      const created = Math.floor(Date.now() / 1000);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=UTF-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }

      try {
        const itr = await model.generateContentStream({
          contents,
          generationConfig: { temperature },
        });

        for await (const chunk of itr.stream) {
          const token = chunk.text();
          res.write(
            `data: ${JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created,
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
          
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        }

        res.write('data: [DONE]\n\n');
        return res.end();
      } catch (streamError) {
        res.write(`data: ${JSON.stringify({
          error: {
            message: 'Streaming failed',
            type: 'api_error',
          }
        })}\n\n`);
        return res.end();
      }
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
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'api_error',
      }
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API up on :${PORT}`);
});
