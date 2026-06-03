export const config = { runtime: 'edge' };

const SYSTEM_PROMPTS = {
  lesson: `You are an expert 6th grade mathematics educator. Generate detailed lesson page content for image generation.

Output ONLY page blocks in this exact format (no intro, no explanation):
--PAGE 1 - [TITLE]--

[Page content with sections, explanations, examples, definitions]

--PAGE 2 - [TITLE]--

[Page content]

Rules:
- Each page covers one focused topic or section
- Include Learning Objectives, Key Concepts, Examples, Practice problems
- Write for visual layout: use bullet points, numbered steps, clear sections
- Generate 4-6 pages
- Titles in Sentence case, no emojis`,

  practice: `You are an expert 6th grade mathematics educator. Generate practice activity exercises for image generation.

Output ONLY page blocks in this exact format (no intro, no explanation):
--PAGE 1 - [TITLE]--

[Exercises, problems, activities]

--PAGE 2 - [TITLE]--

[Exercises]

Rules:
- Each page has 8-15 exercises of progressive difficulty
- Include multiple choice, short answer, and word problems
- NO answer lines, blanks, underscores, or checkboxes — questions only
- Generate 2-4 pages
- Titles in Sentence case, no emojis`,

  lessonplan: `You are an expert 6th grade mathematics curriculum designer. Generate a structured lesson plan for image generation.

Output ONLY page blocks in this exact format (no intro, no explanation):
--PAGE 1 - [TITLE]--

[Lesson plan content with sections]

--PAGE 2 - [TITLE]--

[Content]

Rules:
- Pages: Learning Objectives, Standards Alignment, Materials, Warm-Up, Direct Instruction, Guided Practice, Independent Practice, Closure/Assessment
- Professional educator language
- Generate 3-5 pages
- Titles in Sentence case, no emojis`,

  all: `You are an expert 6th grade mathematics educator. Generate a complete lesson package for image generation.

Output page blocks in this exact format (no intro, no explanation):
--PAGE 1 - [TITLE]--

[Content]

Rules:
- First generate 3-4 Lesson pages (concepts + examples)
- Then 2-3 Practice Activity pages (exercises only, NO answer lines)
- Then 2-3 Lesson Plan pages (curriculum structure)
- Separate each type clearly
- Titles in Sentence case, no emojis`,
};

function buildUserPrompt(docType, userInput, unit, lesson, ccss) {
  return `Unit ${unit || '?'} | Lesson ${lesson || '?'} | CCSS: ${ccss || 'N/A'}

Topic/Instructions:
${userInput}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 }); }

  const { apiKey, model = 'claude-sonnet-4-6', docType = 'all', userInput, unit, lesson, ccss, systemPrompt: customSystemPrompt } = body;

  if (!apiKey) return new Response(JSON.stringify({ error: 'Claude API key obrigatória.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  if (!userInput?.trim()) return new Response(JSON.stringify({ error: 'Descreva o conteúdo da aula.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const systemPrompt = customSystemPrompt?.trim() || SYSTEM_PROMPTS[docType] || SYSTEM_PROMPTS.all;
  const userPrompt   = buildUserPrompt(docType, userInput, unit, lesson, ccss);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || `Claude API error ${res.status}` }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify({ content: data.content?.[0]?.text || '', usage: data.usage }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
