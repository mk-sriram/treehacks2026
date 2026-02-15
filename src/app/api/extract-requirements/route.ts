
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const runtime = 'nodejs';

const SYSTEM_PROMPT = `
You are an expert procurement agent. Your goal is to extract structured procurement requirements from a conversation.
Extract the following fields into a JSON object:

- item (string): The specific item to procure. Be descriptive (include material, type, specs).
- quantity (string): The quantity needed (e.g. "1,000 units", "50kg", "10,000").
- leadTime (string): When it is needed by (e.g. "30 days", "next week"). Default to "30 days" if not specified.
- quality (string): Any quality constraints, certifications (ISO, ASTM), or brands. Default to "Standard" if not specified.
- location (string): Preferred supplier location. Default to "Auto-detected" if not specified.

If a field is missing, try to infer it from context or set it to null (except defaults mentioned above).
Return ONLY valid JSON.
`;

export async function POST(req: Request) {
    try {
        const { messages } = await req.json();

        if (!messages || !Array.isArray(messages)) {
            return NextResponse.json({ error: 'Invalid messages format' }, { status: 400 });
        }

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            console.warn('[API] OPENAI_API_KEY missing, falling back to regex on client');
            return NextResponse.json({ error: 'OPENAI_API_KEY missing' }, { status: 503 });
        }

        const openai = new OpenAI({ apiKey });

        // Format conversation history
        const conversation = messages
            .map((m: any) => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
            .join('\n\n');

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `CONVERSATION:\n${conversation}\n\nExtract JSON:` }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
        });

        const content = completion.choices[0].message.content;

        if (!content) {
            return NextResponse.json({ error: 'No response from OpenAI' }, { status: 500 });
        }

        try {
            const extraction = JSON.parse(content);
            console.log('[API] OpenAI extraction result:', JSON.stringify(extraction, null, 2));
            return NextResponse.json({ extraction });
        } catch (e) {
            console.error('[API] Failed to parse JSON:', content);
            return NextResponse.json({ error: 'JSON parse error' }, { status: 500 });
        }

    } catch (err: any) {
        console.error('[API] Extraction error:', err);
        return NextResponse.json({ error: `OpenAI API error: ${err.message}` }, { status: 500 });
    }
}
