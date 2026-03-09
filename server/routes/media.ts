import express, { Router, Request, Response, NextFunction } from 'express';
import type { AuthRequest } from '../types/index.js';

const router: Router = express.Router();

// Audio transcription endpoint
router.post('/transcribe', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const multer = (await import('multer')).default;
        const upload = multer({ storage: multer.memoryStorage() });

        upload.single('audio')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: 'Failed to process audio file' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No audio file provided' });
            }

            const apiKey: string | undefined = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                return res.status(500).json({ error: 'OpenAI API key not configured. Please set OPENAI_API_KEY in server environment.' });
            }

            try {
                // @ts-expect-error - form-data is an optional dependency
                const FormData = (await import('form-data')).default;
                const formData = new FormData();
                formData.append('file', req.file.buffer, {
                    filename: req.file.originalname,
                    contentType: req.file.mimetype
                });
                formData.append('model', 'whisper-1');
                formData.append('response_format', 'json');
                formData.append('language', 'en');

                const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        ...formData.getHeaders()
                    },
                    body: formData
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
                    throw new Error(errorData.error?.message || `Whisper API error: ${response.status}`);
                }

                const data = await response.json() as { text?: string };
                let transcribedText: string = data.text || '';

                const mode: string = req.body.mode || 'default';

                if (!transcribedText) {
                    res.json({ text: '' });
                    return;
                }

                if (mode === 'default') {
                    res.json({ text: transcribedText });
                    return;
                }

                try {
                    // @ts-expect-error - openai is an optional dependency
                    const OpenAI = (await import('openai')).default;
                    const openai = new OpenAI({ apiKey });

                    let prompt: string | undefined;
                    let systemMessage: string | undefined;
                    let temperature: number = 0.7;
                    let maxTokens: number = 800;

                    switch (mode) {
                        case 'prompt':
                            systemMessage = `You are an expert prompt engineer. Transform the user's rough instruction into a clear, detailed, and context-aware AI prompt.

Your enhanced prompt should:
1. Be specific and unambiguous
2. Include relevant context and constraints
3. Specify the desired output format
4. Use clear, actionable language
5. Include examples where helpful
6. Consider edge cases and potential ambiguities

Respond only with the enhanced prompt.`;
                            prompt = transcribedText;
                            break;

                        case 'vibe':
                        case 'instructions':
                        case 'architect':
                            systemMessage = `You are a helpful assistant that formats ideas into clear, actionable instructions for AI agents.

Transform the user's idea into clear, well-structured instructions that an AI agent can easily understand and execute.

IMPORTANT RULES:
- Format as clear, step-by-step instructions
- Add reasonable implementation details based on common patterns
- Only include details directly related to what was asked
- Do NOT add features or functionality not mentioned
- Keep the original intent and scope intact
- Use clear, actionable language an agent can follow

Respond only with the agent-friendly instructions.`;
                            temperature = 0.5;
                            prompt = transcribedText;
                            break;

                        default:
                            break;
                    }

                    if (prompt) {
                        const completion = await openai.chat.completions.create({
                            model: 'gpt-4o-mini',
                            messages: [
                                { role: 'system', content: systemMessage! },
                                { role: 'user', content: prompt }
                            ],
                            temperature,
                            max_tokens: maxTokens
                        });

                        transcribedText = completion.choices[0].message.content || transcribedText;
                    }

                } catch (gptError: unknown) {
                    console.error('GPT processing error:', gptError);
                    // Fall back to original transcription if GPT fails
                }

                res.json({ text: transcribedText });

            } catch (error: unknown) {
                next(error);
            }
        });
    } catch (error: unknown) {
        next(error);
    }
});

// Image upload endpoint
router.post('/projects/:projectName/upload-images', async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const multer = (await import('multer')).default;
        const path = (await import('path')).default;
        const fs = (await import('fs')).promises;
        const os = (await import('os')).default;

        const storage = multer.diskStorage({
            destination: async (_req: Request, _file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
                const uploadDir = path.join(os.tmpdir(), 'claude-ui-uploads', String(req.user.id));
                await fs.mkdir(uploadDir, { recursive: true });
                cb(null, uploadDir);
            },
            filename: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                cb(null, uniqueSuffix + '-' + sanitizedName);
            }
        });

        const fileFilter = (_req: Request, file: Express.Multer.File, cb: (error: Error | null, acceptFile?: boolean) => void): void => {
            const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
            }
        };

        const upload = multer({
            storage,
            fileFilter,
            limits: {
                fileSize: 5 * 1024 * 1024,
                files: 5
            }
        });

        upload.array('images', 5)(req as Request, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || (req.files as Express.Multer.File[]).length === 0) {
                return res.status(400).json({ error: 'No image files provided' });
            }

            const files = req.files as Express.Multer.File[];

            try {
                const processedImages = await Promise.all(
                    files.map(async (file: Express.Multer.File) => {
                        const buffer = await fs.readFile(file.path);
                        const base64 = buffer.toString('base64');
                        const mimeType = file.mimetype;

                        await fs.unlink(file.path);

                        return {
                            name: file.originalname,
                            data: `data:${mimeType};base64,${base64}`,
                            size: file.size,
                            mimeType
                        };
                    })
                );

                res.json({ images: processedImages });
            } catch (error: unknown) {
                await Promise.all(files.map((f: Express.Multer.File) => fs.unlink(f.path).catch(() => { })));
                next(error);
            }
        });
    } catch (error: unknown) {
        next(error);
    }
});

export default router;
