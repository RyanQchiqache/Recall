import { zipSync } from 'fflate';

/** Package a browser-selected folder for the existing, validated restore flow. */
export async function backupFolderArchive(files: readonly File[]): Promise<File> {
  if (!files.length) throw new Error('The selected folder is empty. Choose a Recall backup folder.');
  const root = files[0].webkitRelativePath.split('/')[0];
  const selected = new Map<string, File>();
  let total = 0;
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 2 || parts[0] !== root || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      throw new Error('Choose one Recall backup folder containing manifest.json and data.json.');
    }
    const relative = parts.slice(1).join('/');
    // Finder can add these files when copying or extracting a backup on macOS.
    if (parts.slice(1).some((part) => part === '.DS_Store' || part === '__MACOSX' || part.startsWith('._'))) continue;
    if (relative !== 'manifest.json' && relative !== 'data.json' && !/^media\/[^/]+$/.test(relative)) {
      throw new Error('Choose the backup folder itself, containing manifest.json, data.json and its media folder.');
    }
    if (selected.has(relative)) throw new Error(`The backup folder contains a duplicate file: ${relative}`);
    selected.set(relative, file);
    total += file.size;
    if (selected.size > 50_000 || total > 1024 * 1024 * 1024) {
      throw new Error('The backup folder is too large. Choose a backup with at most 50,000 files and under 1 GB.');
    }
  }
  if (!selected.has('manifest.json') || !selected.has('data.json')) {
    throw new Error('This folder is missing manifest.json or data.json. Choose the Recall backup folder itself.');
  }
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const [name, file] of selected) entries[name] = new Uint8Array(await file.arrayBuffer());
  // Store without compression to keep folder preparation quick, including images.
  // The server still validates every record, reference and image before previewing.
  const archive = zipSync(entries, { level: 0 });
  if (archive.length > 1024 * 1024 * 1024) throw new Error('The backup folder is too large (over 1 GB).');
  return new File([archive as Uint8Array<ArrayBuffer>], `${root}.zip`, { type: 'application/zip' });
}
