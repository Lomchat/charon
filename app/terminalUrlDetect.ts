// terminalUrlDetect
// ─────────────────────────────────────────────────────────────────────────────
// Extrait les URLs "longues" d'un buffer de texte terminal (typiquement de
// xterm.js), en joignant les morceaux séparés par des newlines/CR.
//
// Pourquoi : `claude login` affiche un URL OAuth de ~250 chars qui dans un
// terminal 80-col est hard-wrappé par le programme remote ou soft-wrappé par
// xterm. Dans les deux cas, l'user ne peut pas double-cliquer / sélectionner
// proprement pour copier — d'où un overlay qui reconstruit l'URL complet.
//
// L'algo gère les 2 cas :
//   - HARD wrap : le programme a inséré `\n` au milieu de l'URL. On joint
//     en sautant les `\r\n` quand la ligne suivante commence par un caractère
//     URL-safe.
//   - SOFT wrap : pas de `\n` dans le stream, juste un wrap visuel xterm. La
//     regex naturelle marche, on extrait l'URL d'un coup.

// CSI (ESC [ ...), OSC (ESC ] ... BEL), et autres séquences ANSI courantes.
// Suffisant pour `claude login` qui n'utilise que des CSI/OSC/SGR standards.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PXY^_].*?\x1b\\/g;

// Caractères acceptés dans un URL : unreserved + reserved + % (percent-encoded).
// On exclut volontairement l'espace, le " et le < pour s'arrêter à la fin du
// token, même si techniquement certains chars (espace) pourraient apparaître
// en encodé — mais en pratique, dans une URL OAuth, on ne les rencontre pas
// décodés.
const URL_CHAR = /[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;

/**
 * Extrait les URLs "intéressantes" (longueur >= minLen) d'un buffer texte.
 *
 * @param raw    Texte brut tel que reçu du flux SSE (peut contenir codes ANSI)
 * @param minLen Seuil de longueur — en-dessous, l'user peut copier à la main
 * @param maxLen Cap de sécurité — au-delà, on stoppe pour éviter de coller
 *               un URL avec un mot qui suivrait au newline (faux positif rare
 *               mais possible). 2000 couvre largement les URLs OAuth réels
 *               (~300-800 chars typiquement).
 * @returns      URLs uniques, dans l'ordre d'apparition (les + récents en queue)
 */
export function extractWrappedUrls(raw: string, minLen = 60, maxLen = 2000): string[] {
  // Strip ANSI d'abord pour éviter que les codes brouillent le regex URL.
  const clean = raw.replace(ANSI_RE, '');
  const out: string[] = [];
  const seen = new Set<string>();
  const startRe = /https?:\/\//gi;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(clean)) !== null) {
    let pos = m.index + m[0].length;
    let url = m[0];
    while (pos < clean.length && url.length < maxLen) {
      const c = clean[pos];
      if (URL_CHAR.test(c)) {
        url += c;
        pos++;
        continue;
      }
      if (c === '\n' || c === '\r') {
        // Compte les newlines consécutifs. Plus d'1 = paragraph break, on
        // arrête (ne pas avaler le texte qui suit le paragraphe).
        // ZÉRO espace toléré entre lignes : un vrai URL OAuth n'a pas
        // d'indentation à la reprise.
        let next = pos;
        let nlCount = 0;
        while (next < clean.length && (clean[next] === '\n' || clean[next] === '\r')) {
          if (clean[next] === '\n') nlCount++;
          next++;
        }
        if (nlCount > 1) break;       // paragraph break : on arrête
        if (next >= clean.length) break;
        if (URL_CHAR.test(clean[next])) {
          pos = next;
          continue;
        }
        break;
      }
      break;
    }
    if (url.length >= minLen && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
