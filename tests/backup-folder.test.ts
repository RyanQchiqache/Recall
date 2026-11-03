/// <reference lib="dom" />
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { backupFolderArchive } from '../src/lib/backupFolder.ts';
import { Canvas } from '../server/lib/png.ts';
import { makeApp, seedHierarchy, type TestApp } from './helpers.ts';

function folderFile(relativePath: string, content: string | Uint8Array = '{}'): File {
  const file = new File([typeof content === 'string' ? content : new Uint8Array(content)], relativePath.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    fs.rmSync(app.dataDir, { recursive: true, force: true });
  }
});

describe('backup folders', () => {
  it.each(['full', 'course'] as const)('previews and restores an extracted %s export including images', async (kind) => {
    const source = await makeApp();
    apps.push(source);
    const hierarchy = await seedHierarchy(source, [1]);
    const png = new Canvas(8, 8, [10, 20, 30]).toPng();
    const media = (await source.upload('/api/media', 'image.png', png, 'image/png')).body;
    await source.api('POST', '/api/cards', { sectionId: hierarchy.sections[0].id, front: `![image](${media.url})`, back: 'Answer' });
    const exported = await source.raw('GET', kind === 'full' ? '/api/export/full' : `/api/export/course/${hierarchy.course.id}`);
    expect(exported.status).toBe(200);
    const files = Object.entries(unzipSync(exported.buffer)).map(([name, bytes]) => folderFile(`recall_backup/${name}`, bytes));
    files.push(folderFile('recall_backup/.DS_Store'), folderFile('recall_backup/media/._image.png'));
    const archive = await backupFolderArchive(files);
    const target = await makeApp();
    apps.push(target);
    const preview = await target.upload('/api/restore/preview', archive.name, Buffer.from(await archive.arrayBuffer()), archive.type);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ kind, counts: { cards: 2, media_assets: 1 }, warnings: [] });
    // Selecting a folder and previewing must not change the existing database.
    expect(target.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 0 });
    if (kind === 'full') {
      expect((await target.api('POST', '/api/restore/apply', { token: preview.body.token, confirm: true })).status).toBe(200);
    } else {
      const destination = await seedHierarchy(target, [0]);
      expect((await target.api('POST', '/api/import/package', { token: preview.body.token, semesterId: destination.semester.id, includeSchedules: false })).status).toBe(201);
    }
    expect(target.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 2 });
    expect(fs.readFileSync(path.join(target.dataDir, 'media', media.filename))).toEqual(png);
  });

  it('explains when the selected folder is empty, incomplete or a parent folder', async () => {
    await expect(backupFolderArchive([])).rejects.toThrow('empty');
    await expect(backupFolderArchive([folderFile('backup/data.json')])).rejects.toThrow('missing manifest.json or data.json');
    await expect(backupFolderArchive([folderFile('parent/backup/manifest.json')])).rejects.toThrow('backup folder itself');
  });

  it('rejects unsafe paths and files from different roots', async () => {
    await expect(backupFolderArchive([folderFile('backup/media/../data.json')])).rejects.toThrow('Choose one');
    await expect(backupFolderArchive([folderFile('backup/manifest.json'), folderFile('other/data.json')])).rejects.toThrow('Choose one');
  });

  it('rejects oversized folders before reading their contents', async () => {
    const file = folderFile('backup/data.json');
    Object.defineProperty(file, 'size', { value: 1024 * 1024 * 1024 + 1 });
    await expect(backupFolderArchive([file])).rejects.toThrow('too large');
  });

  it('still rejects malformed backup data through the server validation', async () => {
    const target = await makeApp();
    apps.push(target);
    await seedHierarchy(target, [1]);
    const archive = await backupFolderArchive([
      folderFile('backup/manifest.json', 'invalid JSON'),
      folderFile('backup/data.json'),
    ]);
    const preview = await target.upload('/api/restore/preview', archive.name, Buffer.from(await archive.arrayBuffer()));
    expect(preview.status).toBe(400);
    expect(target.ctx.db.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 1 });
  });
});
