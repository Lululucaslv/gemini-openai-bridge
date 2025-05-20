import express, { Application, Request, Response } from 'express';
import bodyParser from 'body-parser';
import { randomUUID } from 'crypto';
import { GoogleGenerativeAI, Content } from '@google/generative-ai';

// 初始化 express 应用
const app: Application = express();
app.use(bodyParser.json());

// Google API-Key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// 预览模型 ID
const MODEL_ID = 'gemini-2.5-pro-preview-05-06';

// GET /v1/models
app.get('/v1/models', (_req: Request, res: Response) => {
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
  const {
    messages,
    stream = false,
    temperature = 0.7,
  }: {
    messages: { role: string; content: string }[];
    stream?: boolean;
    temperature?: number;
  } = req.body;

  // OpenAI → Gemini contents
  const contents: Content[] = messages.map(({ role, content }) => ({
    role: (role === 'assistant' ? 'model' : role) as 'user' | 'model' | 'function',
    parts: [{ text: content }],
  }));

  const model = genAI.getGenerativeModel({ model: MODEL_ID });

  // 流式输出
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // @ts-ignore: flush 在 node http.ServerResponse 存在，但 express 类型未声明
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
        })}\n\n`
      );
      // @ts-ignore
      res.flush?.();
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 非流式输出
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

// 启动监听
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API up on :${PORT}`);
});
