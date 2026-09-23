// Le desk — la salle des machines, à part de Charon mais branchée dessus.
//
// ─── Pourquoi une route à part ────────────────────────────────────────────────
// Le desk n'est pas une vue de Charon : c'est une autre façon de le regarder.
// Il vit dans son propre dossier, il a sa propre feuille de style, et il monte
// sa propre racine (`position: fixed; inset: 0`) — celle de Charon ne le
// concerne pas. Caddy n'a rien eu à apprendre : le site proxifie déjà tout
// l'origine vers le serveur Next, donc `/desk` existe dès que ce fichier existe.
//
// ─── Ce que le serveur rend, et ce qu'il ne rend pas ─────────────────────────
// Ici on ne rend que ce qui ne bouge pas : les machines et leurs dossiers, lus
// en base comme le fait `page.tsx` de Charon, dans le même ordre. Les sessions,
// elles, sont demandées par le client à `GET /api/claude/sessions` — la route
// que Charon utilise déjà pour sa barre latérale. C'est délibéré : cette route
// annote chaque session avec son statut vivant, ses permissions en attente et
// son dernier message, et redire cette logique côté serveur en aurait fait une
// deuxième vérité, qui aurait dérivé de la première. Le desk lit Charon ; il ne
// le réimplémente pas.

import { asc } from 'drizzle-orm';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
// `claude.css` est une feuille de PAGE dans Charon (importée par `app/page.tsx`),
// pas une feuille du layout. Le modal du desk monte la vraie vue de session de
// Charon : sans cet import, elle s'afficherait sans sa grille ni ses couleurs.
// Les jetons de thème, eux, viennent déjà du layout racine — donc de `data-theme`
// sur <html>, et le modal suit le thème choisi dans Charon, y compris le clair.
import '../claude.css';
import './desk.css';
import Desk from './Desk';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'The desk — Charon',
  description: 'Charon’s machine room, in three dimensions'
};

export default async function DeskPage() {
  await requireSession();
  seedInitialData();

  // Les mêmes lectures, dans le même ordre que Charon : l'ordre des dossiers et
  // celui des machines DANS leur dossier sont ceux que l'utilisateur a glissés
  // dans la barre latérale. La salle hérite donc de sa disposition — un dossier
  // est une zone au sol, et le déplacer dans Charon le déplace ici.
  const folders = db.select().from(vpsFoldersTable)
    .orderBy(asc(vpsFoldersTable.position), asc(vpsFoldersTable.createdAt))
    .all();
  const vpsList = db.select().from(vpsTable).orderBy(asc(vpsTable.position)).all();

  return <Desk vpsList={vpsList} folders={folders} />;
}
