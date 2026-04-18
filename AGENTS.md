# Codex Rich Presence — Plan d'implémentation

> Discord Rich Presence pour l'écosystème Codex (OpenAI) : détection simultanée de
> l'app desktop **Codex** et du **CLI Codex**, avec distinction fine entre les deux
> malgré leur nom d'exécutable identique (`codex.exe`).

## 1. Contexte & mission

Projet dérivé de l'architecture `anthropic-rich-presence`. Objectif : afficher sur
Discord l'état actif de l'utilisateur vis-à-vis de Codex — en mode CLI (dev), en
mode app desktop (chat assisté), ou les deux en parallèle.

**Contrainte clé** : les deux binaires s'appellent `codex.exe`. La discrimination
ne peut donc pas reposer sur le nom du processus, mais sur :

1. Le **chemin absolu** de l'exécutable (`ExecutablePath`).
2. Le **processus parent** (terminal pour le CLI, explorer.exe pour l'app).
3. Accessoirement, les **arguments de ligne de commande**.

**Stack cible** : TypeScript + Node.js (cohérence avec `arklay-bot` et
`anthropic-rich-presence`). Pas de Python ici — le déploiement doit rester
un exécutable unique, packagé avec `pkg` ou `@vercel/ncc`.

---

## 2. Architecture

```
codex-rich-presence/
├── src/
│   ├── index.ts                 # entrée, boucle principale, lifecycle
│   ├── config.ts                # constantes + chargement .env
│   ├── detector/
│   │   ├── index.ts             # orchestrateur de détection
│   │   ├── process-scanner.ts   # WMI/tasklist wrapper, liste des codex.exe
│   │   ├── classifier.ts        # CLI vs App — règles de path
│   │   └── state.ts             # machine à états (idle/cli/app/both)
│   ├── rpc/
│   │   ├── client.ts            # wrapper discord-rpc, reconnect, heartbeat
│   │   └── presence-builder.ts  # construit l'Activity payload
│   └── utils/
│       ├── logger.ts            # pino, rotation fichier
│       └── debounce.ts          # éviter le flicker RPC
├── assets/                      # uploadé sur le Developer Portal Discord
│   └── README.md                # inventaire des clés d'images
├── test/
│   ├── classifier.test.ts
│   └── fixtures/                # outputs WMI simulés
├── AGENTS.md                    # ce fichier
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 3. Logique de détection

### 3.1 Scan des processus

Sur Windows, trois approches possibles, par ordre de préférence :

| Méthode | Pro | Contra |
|---|---|---|
| **PowerShell `Get-CimInstance Win32_Process`** | Retourne `ExecutablePath`, `CommandLine`, `ParentProcessId` en un appel | Démarrage PowerShell ~300 ms |
| `wmic process` | Identique mais plus rapide | **Déprécié depuis Win11**, à éviter |
| `tasklist /v` | Natif, rapide | Pas de chemin absolu — inutilisable ici |

→ **Choix : `Get-CimInstance` via `child_process.spawn`**, avec parsing JSON
(`ConvertTo-Json`). Cadence : **toutes les 5 secondes** (compromis réactivité / CPU).

Commande de référence :

```powershell
Get-CimInstance Win32_Process -Filter "Name='codex.exe'" |
  Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate |
  ConvertTo-Json -Compress
```

### 3.2 Classification CLI vs App

Règles appliquées dans `classifier.ts`, dans cet ordre :

1. **Si `ExecutablePath` matche la regex**
   `/\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex\.exe$/i`
   → **CLI** (cas canonique, fourni par l'utilisateur).

2. **Sinon, si le path contient `\node_modules\@openai\codex\`** (variantes
   d'installation : `pnpm`, `yarn`, installs globales non-standard)
   → **CLI**.

3. **Sinon, si le processus parent est un shell**
   (`cmd.exe`, `powershell.exe`, `pwsh.exe`, `WindowsTerminal.exe`, `Code.exe`,
   `bash.exe`, `wt.exe`, `ConEmu*`, `Alacritty.exe`)
   → **CLI** (filet de sécurité).

4. **Sinon** → **App desktop**
   (typiquement `%LocalAppData%\Programs\Codex\codex.exe` ou
   `C:\Program Files\Codex\codex.exe` — à confirmer par télémétrie terrain).

Le classifier retourne `'cli' | 'app' | 'unknown'`. Les `unknown` sont **loggés
mais pas affichés** en RPC pour éviter les faux positifs.

### 3.3 Machine à états

```
            ┌─────────┐
            │  IDLE   │◄──────────────┐
            └────┬────┘               │
                 │ process detected   │ no process for > 10s
                 ▼                    │
         ┌───────────────┐            │
         │ classify…     │            │
         └──┬─────┬──────┘            │
    cli    │     │   app              │
           ▼     ▼                    │
      ┌────────┐ ┌────────┐           │
      │  CLI   │ │  APP   │───────────┤
      └───┬────┘ └───┬────┘           │
          │          │                │
          └────┬─────┘                │
               ▼                      │
          ┌────────┐                  │
          │  BOTH  │──────────────────┘
          └────────┘
```

Le debounce (300 ms) empêche le RPC de clignoter quand un `codex.exe` se termine
puis redémarre (ex : `--help`, commandes one-shot).

---

## 4. États du Rich Presence

### 4.1 Mapping états → payload Discord

| État    | `details`                 | `state`                    | `large_image` | `small_image` |
|---------|---------------------------|----------------------------|---------------|---------------|
| `IDLE`  | *(RPC clear)*             | —                          | —             | —             |
| `CLI`   | `Coding with Codex CLI`   | `Terminal session active`  | `codex_logo`  | `cli_badge`   |
| `APP`   | `Using Codex`             | `Desktop session`          | `codex_logo`  | `app_badge`   |
| `BOTH`  | `Coding with Codex`       | `CLI + Desktop`            | `codex_logo`  | `combo_badge` |

Le timestamp `startTimestamp` est celui du plus ancien processus `codex.exe`
détecté (issu de `CreationDate` WMI). En transition `CLI → BOTH`, on **conserve**
le timestamp existant pour ne pas casser la durée affichée.

### 4.2 Assets à uploader

Dans le Discord Developer Portal, créer une application **"Codex"** avec :

- `codex_logo` — 1024×1024, logo OpenAI Codex (version officielle, cf. docs OpenAI).
- `cli_badge` — 512×512, icône terminal.
- `app_badge` — 512×512, icône fenêtre.
- `combo_badge` — 512×512, composite.

⚠️ **Ne pas réutiliser la Client ID de `anthropic-rich-presence`** — créer une
application distincte pour que l'utilisateur puisse montrer les deux Rich
Presence simultanément (Discord autorise plusieurs activities).

---

## 5. Configuration

`.env.example` :

```dotenv
# Discord Developer Portal → Application → General → Application ID
DISCORD_CLIENT_ID=

# Intervalle de scan (ms). Défaut 5000. Ne pas descendre sous 2000.
SCAN_INTERVAL_MS=5000

# Délai avant de passer en IDLE après disparition des process (ms)
IDLE_GRACE_MS=10000

# Niveau de log : trace | debug | info | warn | error
LOG_LEVEL=info

# Chemin du fichier de log (rotation quotidienne). Vide = stdout seulement.
LOG_FILE=%LOCALAPPDATA%\codex-rich-presence\app.log

# Override pour tests : force un état sans scanner les process
# FORCE_STATE=cli|app|both|idle
```

---

## 6. Dépendances

```json
{
  "dependencies": {
    "discord-rpc": "^4.0.1",
    "pino": "^9.5.0",
    "pino-pretty": "^11.2.2",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "@types/discord-rpc": "^4.0.8",
    "vitest": "^2.1.0",
    "pkg": "^5.8.1"
  }
}
```

**Attention** : `discord-rpc` est en maintenance limitée. Alternative à évaluer :
`@xhayper/discord-rpc` (fork maintenu, même API). Choix final à confirmer au
moment de l'init — vérifier l'activité du repo.

---

## 7. Tests

### 7.1 Unitaires (Vitest)

- `classifier.test.ts` : couverture des 4 règles de classification avec
  fixtures de paths réels (CLI npm, CLI pnpm, app `Program Files`, app
  `LocalAppData`, cas ambigus).
- `state.test.ts` : transitions idle→cli→both→app→idle avec respect du grace.
- `presence-builder.test.ts` : snapshot du payload pour chaque état.

### 7.2 Intégration

Script manuel `test/manual-rpc.ts` qui simule un cycle complet en forçant
`FORCE_STATE` toutes les 15 s — permet de valider visuellement le rendu Discord
sans avoir à lancer Codex.

### 7.3 Validation terrain

Checklist à cocher avant release :

- [ ] Lancer `codex --help` via npm global → détecté CLI, pas App.
- [ ] Lancer Codex desktop → détecté App, pas CLI.
- [ ] Les deux simultanément → état BOTH.
- [ ] Fermer le CLI → retour à APP sans flicker.
- [ ] Killer le processus Discord → reconnexion auto sans crash.
- [ ] Redémarrer Discord → RPC ré-établi sous 30 s.

---

## 8. Cas limites & pièges

1. **CLI lancé par VSCode / Cursor / terminal intégré d'IDE** : le parent sera
   `Code.exe` ou `cursor.exe`. Les ajouter à la liste des shells reconnus
   (règle 3 du classifier).

2. **Codex CLI en mode daemon / watch** : process long, pas d'enjeu.

3. **Install via `bun`** : le path diffère
   (`~\.bun\install\global\node_modules\@openai\codex\...`). La règle 2 (path
   contient `@openai\codex`) couvre ce cas.

4. **Multi-instances CLI** (plusieurs terminaux) : on ne compte qu'**une**
   session CLI, peu importe le nombre de process. Le timestamp reste celui
   du plus ancien.

5. **App Codex en background tray** : si l'utilisateur ferme la fenêtre mais
   l'app reste en tray, le process existe toujours → RPC maintenu. Acceptable
   (cohérent avec Spotify, Steam, etc.).

6. **Arrêt propre** : écouter `SIGINT` / `SIGTERM` → `rpc.clearActivity()` puis
   `rpc.destroy()`. Sinon l'activité reste figée sur Discord pendant ~15 min.

7. **Coût WMI** : `Get-CimInstance` filtré par nom reste sous 50 ms sur une
   machine standard. OK pour 5 s d'intervalle. Si passage à 2 s, envisager
   d'utiliser `powershell -NoProfile -NonInteractive` pour gagner ~100 ms au
   démarrage, ou maintenir une session PowerShell persistante via stdin.

---

## 9. Déploiement

### 9.1 Packaging

```bash
pnpm build            # tsc → dist/
pnpm pkg              # pkg → codex-rich-presence.exe (~40 Mo)
```

### 9.2 Auto-start Windows

Ajouter une tâche planifiée (`schtasks`) plutôt qu'une entrée `Run` du registre
— permet un démarrage silencieux + restart on failure :

```xml
<!-- task-template.xml -->
<Triggers>
  <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
</Triggers>
<Settings>
  <RestartOnFailure>
    <Interval>PT1M</Interval>
    <Count>3</Count>
  </RestartOnFailure>
</Settings>
```

Script d'installation `install.ps1` à fournir.

---

## 10. Roadmap (post-MVP)

- **v1.0** : MVP — détection CLI/App/Both, RPC basique.
- **v1.1** : lecture du CWD du CLI (via `Get-Process | Select Path` + handle
  du terminal parent) → afficher le **nom du repo** en `details`.
- **v1.2** : détection de l'état réel du CLI (prompt en attente vs génération
  en cours) via parsing des logs Codex dans `%AppData%\codex\logs\` — si
  structure stable.
- **v2.0** : fusion avec `anthropic-rich-presence` dans un binaire unique
  `ai-dev-rich-presence` capable de gérer Codex, Codex et potentiellement
  Gemini CLI.

---

## 11. Décisions architecturales (ADR light)

| # | Décision | Justification | Alternatives rejetées |
|---|---|---|---|
| 1 | Node.js + TypeScript | Cohérence avec `anthropic-rich-presence`, `discord-rpc` natif en JS | Python (`pypresence`) — ajouterait une stack |
| 2 | Poll WMI vs ETW | WMI suffit pour 5 s d'intervalle, ETW demande droits élevés | ETW trop lourd pour le besoin |
| 3 | Path-based classification prioritaire | Déterministe, robuste aux renames | Hash du binaire — overkill et cassé à chaque update |
| 4 | Client ID Discord distinct | Permet l'affichage simultané avec Codex RPC | Partager la Client ID — Discord n'affiche qu'une activity par app |

---

## 12. Prompts de travail pour Codex

Quand tu (Codex) travailles sur ce projet :

1. **Avant tout changement au `classifier`**, regarde les fixtures dans
   `test/fixtures/` et ajoute le cas testé **avant** d'écrire le code.
2. **Toute modification du RPC payload** doit être reflétée dans
   `presence-builder.test.ts` (snapshot).
3. **Ne jamais** hardcoder un chemin absolu en dehors du classifier —
   toute règle de path va dans `classifier.ts` avec un commentaire
   qui référence la règle (1, 2, 3 ou 4 de §3.2).
4. Logs : `logger.info` pour les transitions d'état, `logger.debug` pour
   le contenu brut du scan WMI, `logger.trace` pour les payloads RPC.
5. Si tu ajoutes une dépendance, documente-la dans §6 et justifie en PR.
