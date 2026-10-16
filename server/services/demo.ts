import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.ts';
import { Canvas } from '../lib/png.ts';
import { conflict } from '../lib/util.ts';
import { createCard } from './cards.ts';
import { createItem, removeOrphanTags } from './hierarchy.ts';
import { saveMedia } from './media.ts';
import { createNote } from './notes.ts';
import { createTemplate } from './templates.ts';

/** Generate the IoU illustration used by one demo card. */
function iouFigure(): Buffer {
  const c = new Canvas(640, 360, [250, 248, 245]);
  c.grid(40, [200, 196, 190], 0.35);
  const gt = { x: 120, y: 70, w: 260, h: 200 };
  const pr = { x: 250, y: 130, w: 270, h: 180 };
  c.fillRect(gt.x, gt.y, gt.w, gt.h, [16, 150, 100], 0.12);
  c.fillRect(pr.x, pr.y, pr.w, pr.h, [79, 70, 229], 0.12);
  const ix = Math.max(gt.x, pr.x);
  const iy = Math.max(gt.y, pr.y);
  const iw = Math.min(gt.x + gt.w, pr.x + pr.w) - ix;
  const ih = Math.min(gt.y + gt.h, pr.y + pr.h) - iy;
  c.fillRect(ix, iy, iw, ih, [234, 160, 20], 0.55);
  c.strokeRect(gt.x, gt.y, gt.w, gt.h, [16, 150, 100], 4);
  c.strokeRect(pr.x, pr.y, pr.w, pr.h, [79, 70, 229], 4);
  return c.toPng();
}

export function loadDemo(ctx: Ctx): { programId: string; courseId: string } {
  const existing = ctx.db.prepare('SELECT id FROM programs WHERE is_demo = 1 LIMIT 1').get() as { id: string } | undefined;
  if (existing) throw conflict('demo_exists', 'The demo course is already loaded');
  const image = saveMedia(ctx, iouFigure(), 'iou-demo.png', { isDemo: true });
  let ids = { programId: '', courseId: '' };
  ctx.db.transaction(() => {
    const demo = { isDemo: true };
    const program = createItem(ctx, 'program', {
      title: 'M.Sc. Informatics (demo)',
      description:
        'Demo material created by Recall to show what cards can contain. It is not an official syllabus or exam source. Remove it in one step from Settings → Demo content.',
    }, demo);
    const semester = createItem(ctx, 'semester', {
      programId: program.id,
      title: 'Winter semester 2026/27 (demo)',
      startDate: '2026-10-01',
      endDate: '2027-03-31',
    }, demo);
    const course = createItem(ctx, 'course', {
      semesterId: semester.id,
      title: 'Computer Vision (demo)',
      moduleCode: 'DEMO-CV',
      color: 'teal',
      icon: 'camera',
      description: 'A small, manually written demo course. Edit or delete anything — it is yours.',
    }, demo);
    const w1 = createItem(ctx, 'section', {
      courseId: course.id,
      title: 'Week 01 — Image formation & filtering',
      kind: 'lecture',
      weekNumber: 1,
      notes: 'Demo section showing equations and long answers.',
    }, demo);
    const w2 = createItem(ctx, 'section', {
      courseId: course.id,
      title: 'Week 02 — Object detection',
      kind: 'lecture',
      weekNumber: 2,
      notes: 'Demo section showing code and images.',
    }, demo);

    const cards = [
      {
        sectionId: w1.id,
        front: 'Write down the 2D discrete **convolution** of an image $I$ with a kernel $K$.',
        back: '$$\n(I * K)(x, y) = \\sum_{i=-k}^{k} \\sum_{j=-k}^{k} I(x - i,\\, y - j)\\, K(i, j)\n$$',
        explanation:
          'Most deep-learning libraries actually implement **cross-correlation**, $\\sum I(x+i, y+j)K(i,j)$, i.e. convolution with a flipped kernel. For learned kernels the difference does not matter.',
        hint: 'Note the minus signs inside $I(\\cdot)$.',
        source: 'Demo — Week 01',
        tags: ['demo', 'math'],
      },
      {
        sectionId: w1.id,
        front: 'Give the 2D Gaussian kernel. Why is it useful that it is **separable**?',
        back: [
          '$$',
          'G_\\sigma(x, y) = \\frac{1}{2\\pi\\sigma^2} \\exp\\!\\left(-\\frac{x^2 + y^2}{2\\sigma^2}\\right) = g_\\sigma(x)\\, g_\\sigma(y)',
          '$$',
          '',
          'Separable means the 2D filter equals two 1D filters applied one after another. For a $k \\times k$ kernel this reduces the cost per pixel from $O(k^2)$ to $O(2k)$.',
        ].join('\n'),
        source: 'Demo — Week 01',
        tags: ['demo', 'math'],
      },
      {
        sectionId: w1.id,
        front: 'Explain the main steps of the **Canny edge detector** and the purpose of each.',
        back: [
          '1. **Smoothing** — convolve with a Gaussian to suppress noise, because derivatives amplify noise.',
          '2. **Gradient computation** — estimate $\\partial I/\\partial x$ and $\\partial I/\\partial y$ (e.g. Sobel), then the magnitude $\\lVert \\nabla I \\rVert = \\sqrt{I_x^2 + I_y^2}$ and orientation $\\theta = \\operatorname{atan2}(I_y, I_x)$.',
          '3. **Non-maximum suppression** — keep a pixel only if its magnitude is a local maximum along the gradient direction. This thins wide ridges to one-pixel edges.',
          '4. **Double threshold** — classify pixels as strong ($> T_{high}$), weak ($T_{low}..T_{high}$) or suppressed.',
          '5. **Hysteresis** — keep weak pixels only if they connect to a strong pixel. This removes isolated noise responses while keeping continuous contours.',
          '',
          '**Trade-offs.** A larger $\\sigma$ gives fewer spurious edges but worse localisation and missed fine detail. The thresholds trade recall against precision; a ratio of about $T_{high} : T_{low} = 2{:}1$ to $3{:}1$ is a common starting point.',
          '',
          '> This long answer shows that cards grow with their content instead of shrinking the text.',
        ].join('\n'),
        source: 'Demo — Week 01',
        tags: ['demo'],
      },
      {
        sectionId: w2.id,
        front: 'Implement **intersection over union** (IoU) for two axis-aligned boxes given as `(x1, y1, x2, y2)`.',
        back: [
          '```python',
          'def iou(a, b):',
          '    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])',
          '    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])',
          '    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)',
          '    area_a = (a[2] - a[0]) * (a[3] - a[1])',
          '    area_b = (b[2] - b[0]) * (b[3] - b[1])',
          '    union = area_a + area_b - inter',
          '    return inter / union if union > 0 else 0.0',
          '```',
        ].join('\n'),
        explanation: 'Clamp with `max(0, …)` so that disjoint boxes give zero intersection instead of a negative area.',
        source: 'Demo — Week 02',
        tags: ['demo', 'code'],
      },
      {
        sectionId: w2.id,
        front: `In this figure the green box is the ground truth and the indigo box is a prediction. Which region is the numerator of IoU, and roughly what is the IoU here?\n\n![Two overlapping bounding boxes](${image.url})`,
        back: 'The **amber overlap** (intersection) is the numerator; the union of both boxes is the denominator.\n\nIntersection ≈ $130 \\times 140 = 18\\,200$, union ≈ $52\\,000 + 48\\,600 - 18\\,200 = 82\\,400$, so $\\text{IoU} \\approx 0.22$ — below the usual 0.5 threshold for a match.',
        source: 'Demo — Week 02',
        tags: ['demo'],
      },
      {
        sectionId: w2.id,
        front: 'What does **non-maximum suppression** (NMS) do in object detection?',
        back: 'It removes duplicate detections: sort boxes by score, keep the best, discard remaining boxes whose IoU with it exceeds a threshold (e.g. $0.5$), and repeat with the rest.',
        hint: 'Think of many overlapping boxes around one object.',
        source: 'Demo — Week 02',
        tags: ['demo'],
      },
    ];
    for (const c of cards) createCard(ctx, c, demo);

    // One example of each card type.
    createNote(ctx, {
      sectionId: w1.id,
      kind: 'basic',
      fields: { front: '**Stride** (convolution)', back: 'The step size with which the kernel moves across the input.', explanation: '', hint: '', source: 'Demo — Week 01' },
      options: { reverse: true },
      tags: ['demo', 'vocabulary'],
    }, demo);
    createNote(ctx, {
      sectionId: w1.id,
      kind: 'cloze',
      fields: {
        text: 'The {{c1::Sobel}} operator estimates the image {{c2::gradient::a vector of derivatives}}; Canny then applies {{c3::non-maximum suppression}} to thin the edges.',
        explanation: 'Each gap is its own card with its own schedule.',
        hint: '',
        source: 'Demo — Week 01',
      },
      tags: ['demo'],
    }, demo);
    createNote(ctx, {
      sectionId: w1.id,
      kind: 'cloze',
      fields: {
        text: 'A Gaussian kernel is separable: $G_\\sigma(x, y) = {{c1::g_\\sigma(x)\\, g_\\sigma(y)}}$, which reduces the cost per pixel from $O(k^2)$ to {{c2::$O(2k)$}}.',
        explanation: '',
        hint: '',
        source: 'Demo — Week 01',
      },
      tags: ['demo', 'math'],
    }, demo);
    createNote(ctx, {
      sectionId: w2.id,
      kind: 'occlusion',
      fields: {
        image: image.url,
        header: 'Green: ground-truth box. Indigo: predicted box.',
        masks: [
          { id: 'demoint1', x: 0.3906, y: 0.3611, w: 0.2031, h: 0.3889, label: 'Intersection (A ∩ B)' },
          { id: 'demopred', x: 0.5938, y: 0.3611, w: 0.2188, h: 0.5, label: 'Prediction only (B \\ A)' },
        ],
        explanation: 'IoU = intersection ÷ union.',
        hint: '',
        source: 'Demo — Week 02',
      },
      options: { occlusionMode: 'hide-all' },
      tags: ['demo'],
    }, demo);
    const tpl = createTemplate(ctx, {
      name: 'Term · definition · example (demo)',
      fields: [{ name: 'Term' }, { name: 'Definition' }, { name: 'Example' }],
      cards: [
        { name: 'Term → definition', front: '{{Term}}', back: '{{FrontSide}}\n\n---\n\n{{Definition}}{{#Example}}\n\n*Example:* {{Example}}{{/Example}}' },
        { name: 'Definition → term', front: '{{Definition}}', back: '{{Term}}' },
      ],
    }, demo);
    const [fTerm, fDef, fEx] = tpl.fields.map((f) => f.id);
    createNote(ctx, {
      sectionId: w2.id,
      kind: 'template',
      templateId: tpl.id,
      fields: {
        values: { [fTerm]: 'Receptive field', [fDef]: 'The region of the input image that affects one unit of a feature map.', [fEx]: 'Two stacked 3×3 convolutions see a 5×5 region.' },
        explanation: '',
        hint: '',
        source: 'Demo — Week 02',
      },
      tags: ['demo', 'vocabulary'],
    }, demo);
    ids = { programId: program.id, courseId: course.id };
  })();
  return ids;
}

export function removeDemo(ctx: Ctx): { removedPrograms: number } {
  const open = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM session_cards sc JOIN study_sessions s ON s.id = sc.session_id AND s.is_open = 1
       JOIN cards c ON c.id = sc.card_id WHERE c.is_demo = 1`,
    )
    .get() as { n: number };
  if (open.n > 0) throw conflict('in_open_session', 'The open study session uses demo cards. Finish or end it first.');
  const media = ctx.db.prepare('SELECT filename FROM media_assets WHERE is_demo = 1').all() as { filename: string }[];
  let removed = 0;
  ctx.db.transaction(() => {
    removed = ctx.db.prepare('DELETE FROM programs WHERE is_demo = 1').run().changes;
    // Demo items created under the user's own hierarchy are not touched; only demo-flagged trees are removed.
    ctx.db.prepare('DELETE FROM study_sessions WHERE is_open IS NULL AND id NOT IN (SELECT DISTINCT session_id FROM session_cards)').run();
    ctx.db.prepare('DELETE FROM media_assets WHERE is_demo = 1').run();
    ctx.db.prepare('DELETE FROM note_templates WHERE is_demo = 1 AND id NOT IN (SELECT template_id FROM notes WHERE template_id IS NOT NULL)').run();
    removeOrphanTags(ctx);
  })();
  for (const m of media) fs.rmSync(path.join(ctx.config.mediaDir, m.filename), { force: true });
  return { removedPrograms: removed };
}
