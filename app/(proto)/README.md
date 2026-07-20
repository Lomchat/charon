# TEMP — Maquettes « fleet view » (/v1 /v2 /v3)

Prototypes JETABLES pour choisir une direction d'UI "voir mes agents
travailler". Données 100% simulées (`mock.ts`) — RIEN n'est branché au
SDK/SSE/DB.

- `/v1` — Claudeville : village 2D (canvas pur, zéro dépendance)
- `/v2` — react-three-fiber : salle des machines 3D (three/@react-three/*)
- `/v3` — React Flow : mission control en graphe vivant (@xyflow/react)

Pour tout retirer : supprimer `app/(proto)/` et désinstaller
`three @types/three @react-three/fiber @react-three/drei @xyflow/react`,
puis retirer la ligne (proto) de CLAUDE.md §2.
