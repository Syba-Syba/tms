import { useCallback, useState } from 'react';

/**
 * Copies text, falling back to the selection API where the async clipboard is missing.
 *
 * navigator.clipboard exists only in a secure context. Over plain HTTP on a home network it
 * is undefined, so the copy silently did nothing and the button still said it had worked.
 * execCommand('copy') is deprecated but is the one path every browser still honours there.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused or no focus; try the selection route before giving up.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function useCopyToClipboard(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      setCopied(ok);
      setFailed(!ok);
      setTimeout(() => {
        setCopied(false);
        setFailed(false);
      }, resetAfterMs);
      return ok;
    },
    [resetAfterMs],
  );

  return { copied, failed, copy };
}
