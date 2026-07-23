// fonts.mjs — make the BUNDLED premium caption faces (shorts/assets/fonts) resolvable by
// rsvg-convert on BOTH a dev Mac and the Ubuntu CI runner, with no manual install step.
//
// WHY THIS IS NEEDED (learned the hard way): rsvg-convert renders text through pango, whose
// font backend DIFFERS by platform —
//   • macOS  → pango-coretext, which IGNORES $FONTCONFIG_FILE and only sees fonts registered
//              with CoreText (i.e. installed under ~/Library/Fonts or /Library/Fonts).
//   • Linux  → pango-fontconfig, which reads $FONTCONFIG_FILE / ~/.local/share/fonts + fc-cache.
// A repo `fonts.conf` alone therefore works on CI but SILENTLY falls back to a system font on
// a Mac (every family collapsed to the same default hash in testing). The one approach that
// works everywhere is to COPY the bundled TTFs into the OS user-font dir at startup and, on
// Linux, refresh the fontconfig cache. Idempotent + best-effort: a failure never blocks a
// render (it just falls back to the OS font, as before).

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const FONT_SRC = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts');

// Per-OS user font directory rsvg's backend actually reads.
function userFontDir() {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Fonts');
  // Linux (CI) + others: XDG user fonts.
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'fonts');
}

let done = false; // install once per process

// Copy the bundled .ttf files into the OS user-font dir (namespaced so we never clobber a
// user's own fonts) and refresh the Linux font cache. Returns the list of installed families
// for logging. Safe to call repeatedly; no-ops after the first run.
export async function ensureFonts() {
  if (done) return;
  done = true;
  try {
    const dir = userFontDir();
    await mkdir(dir, { recursive: true });
    const files = (await readdir(FONT_SRC)).filter((f) => /\.(ttf|otf)$/i.test(f));
    let copied = 0;
    for (const f of files) {
      const dest = join(dir, `Agyata-${f}`);
      // Skip if already installed with the same size (cheap idempotency — fonts don't change).
      try {
        const [s, d] = await Promise.all([stat(join(FONT_SRC, f)), stat(dest).catch(() => null)]);
        if (d && d.size === s.size) continue;
      } catch {
        /* fall through to copy */
      }
      await copyFile(join(FONT_SRC, f), dest);
      copied++;
    }
    // Linux: rebuild the fontconfig cache so pango sees the new files this run. macOS CoreText
    // registers user fonts automatically (verified), so no cache step there.
    if (copied && platform() !== 'darwin') {
      await execFileP('fc-cache', ['-f', dir]).catch(() => {});
    }
    if (copied) console.log(`[fonts] installed ${copied} bundled font(s) → ${dir}`);
  } catch (e) {
    console.log(`[fonts] bundle install skipped (${e.message}); falling back to OS fonts`);
  }
}
