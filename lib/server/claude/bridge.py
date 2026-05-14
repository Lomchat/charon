#!/usr/bin/env python3
# Bridge entre une session SSH et un process ClaudeSDKClient.
#
# Protocole stdin (JSON par ligne) :
#   {"type":"init","cwd":"/path","session_id":"...","permission_mode":"normal|acceptEdits|bypass|plan"}
#     -> doit etre la PREMIERE ligne
#   {"type":"user_message","content":"..."}
#   {"type":"interrupt"}
#   {"type":"permission_response","id":"...","allow":true|false}
#
# Protocole stdout (JSON par ligne) :
#   {"type":"ready"}                              # bridge pret a recevoir des messages
#   {"type":"session_id","id":"..."}              # uuid SDK (a memoriser pour resume)
#   {"type":"assistant_text","delta":"..."}       # token de texte assistant
#   {"type":"thinking","text":"..."}              # bloc de reflexion
#   {"type":"tool_use","id":"...","name":"...","input":{...}}
#   {"type":"tool_result","tool_use_id":"...","content":"...","is_error":bool}
#   {"type":"permission_request","id":"...","tool":"...","input":{...}}
#   {"type":"todo_update","todos":[...]}
#   {"type":"stop","subtype":"..."}               # fin de reponse assistant
#   {"type":"error","msg":"...","fatal":bool}
#
# Sortie verbeuse vers stderr (le SessionWorker la log).

import sys
import json
import asyncio
import traceback

def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, default=str) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

def warn(msg):
    try:
        sys.stderr.write(str(msg) + "\n")
        sys.stderr.flush()
    except Exception:
        pass

# --- Import du SDK (peut echouer si pas installe) -----------------------------
try:
    from claude_agent_sdk import (
        ClaudeSDKClient,
        ClaudeAgentOptions,
        HookMatcher,
    )
except ImportError as e:
    emit({"type": "error", "msg": "claude-agent-sdk indisponible: " + str(e), "fatal": True})
    sys.exit(2)


class Bridge:
    def __init__(self):
        self.permission_mode = "normal"
        self.pending_perms = {}
        self.stdin_queue = None
        self.session_id_emitted = False
        self.client = None  # ClaudeSDKClient — exposé pour interrupt/mode switch
        # Indique si on a déjà signalé "plan accepté" : on passe en bypass juste
        # après pour que l'exécution post-plan se fasse sans prompts.
        self._plan_accepted = False
        # Capture du stderr du subprocess claude CLI (le SDK n'inclut PAS son
        # contenu dans ProcessError.stderr — il met juste un placeholder).
        # Sans ce callback, la vraie cause d'un exit code != 0 est invisible.
        self._claude_stderr_lines = []

    def _on_claude_stderr(self, line):
        try:
            s = line.rstrip("\n")
            if s:
                self._claude_stderr_lines.append(s)
                if len(self._claude_stderr_lines) > 120:
                    self._claude_stderr_lines = self._claude_stderr_lines[-120:]
                # Mirror dans notre propre stderr aussi (debug local)
                warn("[claude] " + s)
        except Exception:
            pass

    def _captured_stderr(self):
        return "\n".join(self._claude_stderr_lines).strip()

    def _format_err(self, label, e):
        parts = [label + ": " + str(e)]
        for attr in ("exit_code", "cmd"):
            v = getattr(e, attr, None)
            if v is not None:
                parts.append(attr + "=" + str(v))
        # stderr captured directly from the claude subprocess (via SDK callback)
        captured = self._captured_stderr()
        if captured:
            parts.append("--- stderr du claude CLI (capturé) ---\n" + captured[-3000:])
        # Le SDK met un placeholder dans e.stderr — on l'ignore s'il dit juste ça
        sdk_stderr = getattr(e, "stderr", None)
        if sdk_stderr and "Check stderr output for details" not in str(sdk_stderr):
            parts.append("--- SDK.e.stderr ---\n" + str(sdk_stderr)[:1000])
        parts.append("--- traceback ---\n" + traceback.format_exc())
        return "\n".join(parts)

    # --- Hooks -----------------------------------------------------------------
    SNAPSHOT_TOOLS = {"Edit", "Write", "MultiEdit"}
    SNAPSHOT_MAX = 256 * 1024  # 256KB max per snapshot

    def _snapshot_file(self, file_path, phase, tool_use_id):
        try:
            with open(file_path, "r", errors="replace") as f:
                content = f.read()
            size = len(content)
            truncated = False
            if size > self.SNAPSHOT_MAX:
                content = content[: self.SNAPSHOT_MAX]
                truncated = True
            emit({
                "type": "edit_snapshot",
                "phase": phase,
                "tool_use_id": tool_use_id or "",
                "file_path": file_path,
                "content": content,
                "size": size,
                "truncated": truncated,
            })
        except FileNotFoundError:
            # Phase 'before' = fichier neuf
            emit({
                "type": "edit_snapshot",
                "phase": phase,
                "tool_use_id": tool_use_id or "",
                "file_path": file_path,
                "content": None,
                "size": 0,
                "truncated": False,
            })
        except Exception as e:
            emit({"type": "error", "msg": "snapshot " + phase + ": " + str(e)})

    # Outils auto-allow universellement (toutes modes) : interactions natives
    # Claude Code sans risque + ExitPlanMode (le plan est déjà visible dans le
    # chat, on l'allow direct et on switche en bypass juste après).
    AUTO_ALLOW_TOOLS = {
        "TodoWrite",
        "ExitPlanMode",
    }
    # Auto-allow ciblés : (tool_name, exact_input_dict). Le match est strict
    # (toutes les clés et valeurs doivent être égales). Utile pour des appels
    # SDK récurrents et inoffensifs qu'on ne veut pas blanket-autoriser.
    AUTO_ALLOW_EXACT = [
        ("ToolSearch", {"query": "select:ExitPlanMode", "max_results": 1}),
    ]
    # Outils auto-allow en plan mode SEULEMENT (lecture-seule + outils web).
    PLAN_MODE_SAFE_TOOLS = {
        "Read", "Grep", "Glob", "LS", "NotebookRead",
        "WebFetch", "WebSearch",
        "TodoWrite",
        # AskUserQuestion passe par can_use_tool (UI dédiée), pas ici.
    }
    # Commandes Bash read-only auto-allow en plan mode. Match du premier mot
    # de chaque segment (séparé par | && || ;) — flags/args ignorés.
    PLAN_MODE_SAFE_BASH = {
        "ls", "dir", "cat", "head", "tail", "more", "less", "find",
        "pwd", "echo", "printf", "date", "whoami", "hostname", "id", "uname",
        "grep", "egrep", "fgrep", "rg", "ag",
        "wc", "file", "du", "df", "stat", "basename", "dirname", "realpath", "readlink",
        "ps", "top", "free", "uptime", "env", "printenv",
        "which", "type", "command", "whereis",
        "sort", "uniq", "cut", "tr", "awk",
        "jq", "yq", "xmllint", "column",
        "true", "false", ":",
        "tree",
        # git read-only
        "git",   # filtré ci-dessous pour sous-commandes seulement
        # node/python info read-only
        "node", "python", "python3", "pip", "pip3", "npm", "yarn", "pnpm",
    }
    # Sous-commandes git autorisées en read-only
    GIT_READ_SUBCMDS = {
        "log", "diff", "status", "show", "branch", "remote", "config",
        "blame", "describe", "rev-parse", "ls-files", "ls-tree", "tag",
        "shortlog", "stash list",
    }
    # Détecteurs de danger : si présent dans la commande → refuse
    DANGEROUS_PATTERNS = (
        " rm ", " rm\t", " rm -", "; rm", "|rm", "&& rm", "rm -rf",
        " mv ", " cp ", " dd ", " mkfs", " chmod ", " chown ",
        " mount ", " umount ", " sudo ", " su ", " kill ", " pkill ",
        ">/dev/", "2>",  # mais 2>/dev/null est OK → traité séparément
        " tee ", "tee ", "curl ", "wget ",
        "-i ",  # sed -i / awk -i
        " >> ", " > ",  # redirection vers fichier
    )

    def _is_safe_bash(self, command):
        """Heuristique : la commande est entièrement read-only ?"""
        if not isinstance(command, str) or not command.strip():
            return False
        # Normalise : ajoute espaces autour pour les detect patterns simples
        c = " " + command.strip() + " "
        # Tolère 2>/dev/null (très commun) → on le vire avant détection danger
        c_clean = c.replace("2>/dev/null", " ").replace("2> /dev/null", " ")
        # Tolère > /dev/null
        c_clean = c_clean.replace(" > /dev/null", " ").replace(" >/dev/null", " ")
        for pat in self.DANGEROUS_PATTERNS:
            if pat in c_clean:
                return False
        # Split en segments par | && || ;
        import re
        segments = re.split(r"\|\||&&|;|\|", command)
        for seg in segments:
            seg = seg.strip()
            if not seg:
                continue
            # Supprime redirections en fin (2>&1, > /dev/null etc.) — déjà filtré au-dessus
            tokens = seg.split()
            if not tokens:
                continue
            first = tokens[0]
            # Skip env=val prefix : VAR=val cmd
            i = 0
            while i < len(tokens) and "=" in tokens[i] and not tokens[i].startswith("-"):
                i += 1
            if i >= len(tokens):
                return False
            first = tokens[i]
            # Strip path : /usr/bin/ls → ls
            first = first.rsplit("/", 1)[-1]
            if first not in self.PLAN_MODE_SAFE_BASH:
                return False
            # git : restreindre aux sous-commandes read-only
            if first == "git" and i + 1 < len(tokens):
                sub = tokens[i + 1]
                if sub not in {x.split()[0] for x in self.GIT_READ_SUBCMDS}:
                    return False
            # node/python/pip/npm : vérifier qu'on n'exécute pas de code
            if first in ("node", "python", "python3"):
                # autorise --version, -V, -h, --help uniquement
                rest = tokens[i + 1:]
                if any(t in ("-e", "-c", "--exec") for t in rest):
                    return False
                if not any(t.startswith("-") for t in rest) and rest:
                    # exécute un fichier → potentiellement modifie
                    return False
            if first in ("pip", "pip3", "npm", "yarn", "pnpm"):
                rest = tokens[i + 1:]
                read_only_sub = {"list", "show", "outdated", "info", "view", "ls", "search", "view"}
                if not rest or rest[0] not in read_only_sub:
                    return False
        return True

    def _is_auto_allowed(self, tool_name, tool_input):
        if tool_name in self.AUTO_ALLOW_TOOLS:
            return True
        for name, exact in self.AUTO_ALLOW_EXACT:
            if tool_name == name and tool_input == exact:
                return True
        if tool_name in self.SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path") if isinstance(tool_input, dict) else None
            if isinstance(fp, str):
                for p in self.AUTO_ALLOW_WRITE_PREFIXES:
                    if fp.startswith(p):
                        return True
        return False

    # Patterns de file_path toujours auto-allowed sur Write/Edit.
    AUTO_ALLOW_WRITE_PREFIXES = (
        "/root/.claude/plans/",
        "/tmp/",
    )

    async def pre_tool_use(self, input_data, tool_use_id, context):
        tool_name = (input_data or {}).get("tool_name", "?")
        tool_input = (input_data or {}).get("tool_input", {}) or {}

        # AskUserQuestion : passe par can_use_tool pour UI dédiée
        if tool_name == "AskUserQuestion":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": "dashboard handles " + tool_name,
                }
            }

        # ExitPlanMode : auto-allow + switch implicite vers bypass.
        # Le plan est déjà visible dans le chat (assistant text + Write events),
        # l'utilisateur a eu le temps de le lire. On laisse Claude exécuter.
        if tool_name == "ExitPlanMode":
            asyncio.create_task(self._switch_to_bypass_after_exit_plan())
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }
            }

        # Plan mode : auto-allow read-only safe tools
        if self.permission_mode == "plan" and tool_name in self.PLAN_MODE_SAFE_TOOLS:
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }
            }

        # Plan mode : auto-allow Bash si commande read-only
        if self.permission_mode == "plan" and tool_name == "Bash":
            cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
            if self._is_safe_bash(cmd):
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                    }
                }

        # Auto-allow universel (TodoWrite, ExitPlanMode, écriture de plan, /tmp)
        if self._is_auto_allowed(tool_name, tool_input):
            if tool_name in self.SNAPSHOT_TOOLS:
                fp = tool_input.get("file_path")
                if fp:
                    self._snapshot_file(fp, "before", tool_use_id)
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }
            }

        # Mode "acceptEdits" : auto-allow uniquement les outils d'edition de
        # fichier (SNAPSHOT_TOOLS), tout le reste passe par le flow permission.
        if self.permission_mode == "acceptEdits" and tool_name in self.SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "before", tool_use_id)
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }
            }

        # Permission flow (skip si bypass)
        if self.permission_mode != "bypass":
            pid = "perm_" + str(tool_use_id or id(input_data))
            loop = asyncio.get_event_loop()
            fut = loop.create_future()
            self.pending_perms[pid] = fut
            emit({"type": "permission_request", "id": pid, "tool": tool_name, "input": tool_input})
            try:
                allowed = await asyncio.wait_for(fut, timeout=600)
            except asyncio.TimeoutError:
                self.pending_perms.pop(pid, None)
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "timeout (10min sans reponse du dashboard)",
                    }
                }
            if not allowed:
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "refuse par le dashboard",
                    }
                }

        # Snapshot du fichier AVANT edition (seulement si permission accordee)
        if tool_name in self.SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "before", tool_use_id)

        # IMPORTANT : il faut retourner un "allow" explicite. Sans ça le SDK
        # retombe sur la decision par defaut qui peut refuser (selon les
        # settings du projet) et Claude croit que le dashboard a refuse.
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
            }
        }

    # --- can_use_tool : intercepte les "ask" pour fournir une réponse riche ---
    # Permet de retourner `updated_input` avec des données — c'est ce qu'on
    # utilise pour AskUserQuestion (on injecte `answers` dans l'input et le
    # CLI propage tel quel à Claude).
    async def can_use_tool(self, tool_name, tool_input, context):
        # Import différé pour ne pas planter à l'import du module si SDK manque
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        if tool_name == "AskUserQuestion":
            questions = (tool_input or {}).get("questions") or []
            qid = "q_" + str(getattr(context, "tool_use_id", None) or id(tool_input))
            loop = asyncio.get_event_loop()
            fut = loop.create_future()
            self.pending_perms[qid] = fut
            emit({
                "type": "user_question",
                "id": qid,
                "questions": questions,
            })
            try:
                answers = await asyncio.wait_for(fut, timeout=1800)
            except asyncio.TimeoutError:
                self.pending_perms.pop(qid, None)
                return PermissionResultDeny(message="timeout (30min sans réponse du dashboard)")
            if not isinstance(answers, dict):
                return PermissionResultDeny(message="réponse invalide du dashboard")
            return PermissionResultAllow(
                updated_input={"questions": questions, "answers": answers}
            )

        return PermissionResultAllow()

    async def _switch_to_bypass_after_exit_plan(self):
        """Après un ExitPlanMode allowed, on bascule en bypass pour que la
        suite exécute sans prompts. Lancé en background (asyncio.create_task)
        pour ne pas bloquer le retour du hook."""
        if self._plan_accepted:
            return
        self._plan_accepted = True
        try:
            await asyncio.sleep(0.05)
            self.permission_mode = "bypass"
            if self.client is not None:
                try:
                    await self.client.set_permission_mode("default")
                except Exception as e:
                    warn("set_permission_mode(default) post-exit-plan: " + str(e))
            emit({"type": "mode_changed", "mode": self.permission_mode})
        except Exception as e:
            warn("_switch_to_bypass_after_exit_plan: " + str(e))

    async def post_tool_use(self, input_data, tool_use_id, context):
        tool_name = (input_data or {}).get("tool_name", "?")
        tool_input = (input_data or {}).get("tool_input", {}) or {}
        if tool_name in self.SNAPSHOT_TOOLS:
            fp = tool_input.get("file_path")
            if fp:
                self._snapshot_file(fp, "after", tool_use_id)
        return {}

    # --- stdin reader ----------------------------------------------------------
    async def stdin_reader(self):
        loop = asyncio.get_event_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                await self.stdin_queue.put(None)  # EOF
                return
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception as e:
                warn("bad json on stdin: " + str(e))
                continue
            t = msg.get("type")
            if t == "permission_response":
                fut = self.pending_perms.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(bool(msg.get("allow")))
            elif t == "question_response":
                # Réponse aux questions AskUserQuestion : answers est un dict
                # {question_text: option_label} ou None si refus.
                fut = self.pending_perms.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(msg.get("answers"))
            elif t == "interrupt":
                # Traité directement ici, sans passer par la queue : le main loop
                # est probablement bloqué dans receive_response() et ne videra
                # pas la queue avant la fin du tour — trop tard.
                if self.client is not None:
                    try:
                        await self.client.interrupt()
                        emit({"type": "interrupted"})
                    except Exception as e:
                        emit({"type": "error", "msg": "interrupt: " + str(e)})
                else:
                    warn("interrupt avant init client")
            elif t == "set_permission_mode":
                # Comme l'interrupt : besoin de passer pendant un receive_response
                # en cours → traité directement, pas via la queue.
                new_mode = msg.get("mode", "normal")
                if new_mode not in ("normal", "acceptEdits", "bypass", "plan"):
                    new_mode = "normal"
                self.permission_mode = new_mode
                # Skip mode "auto" (bypass interne) car le CLI refuse --dangerously en root.
                sdk_mode = "plan" if new_mode == "plan" else "default"
                if self.client is not None:
                    try:
                        await self.client.set_permission_mode(sdk_mode)
                    except Exception as e:
                        warn("set_permission_mode SDK: " + str(e))
                emit({"type": "mode_changed", "mode": new_mode})
            else:
                await self.stdin_queue.put(msg)

    # --- Translate SDK events -> protocol --------------------------------------
    def translate(self, ev):
        out = []
        try:
            ev_type = type(ev).__name__
            # Session id init (souvent dans SystemMessage data['session_id'])
            try:
                data = getattr(ev, "data", None)
                if isinstance(data, dict):
                    sid = data.get("session_id")
                    if sid and not self.session_id_emitted:
                        out.append({"type": "session_id", "id": sid})
                        self.session_id_emitted = True
            except Exception:
                pass
            session_attr = getattr(ev, "session_id", None)
            if session_attr and not self.session_id_emitted:
                out.append({"type": "session_id", "id": session_attr})
                self.session_id_emitted = True

            if ev_type == "AssistantMessage":
                for block in getattr(ev, "content", []) or []:
                    bt = type(block).__name__
                    if bt == "TextBlock":
                        text = getattr(block, "text", "")
                        if text:
                            out.append({"type": "assistant_text", "delta": text})
                    elif bt == "ThinkingBlock":
                        thinking = getattr(block, "thinking", "")
                        if thinking:
                            out.append({"type": "thinking", "text": thinking})
                    elif bt == "ToolUseBlock":
                        tname = getattr(block, "name", "")
                        tinput = getattr(block, "input", {}) or {}
                        out.append({
                            "type": "tool_use",
                            "id": getattr(block, "id", ""),
                            "name": tname,
                            "input": tinput,
                        })
                        # Intercept TodoWrite to emit a dedicated event for the UI
                        if tname == "TodoWrite":
                            todos = tinput.get("todos") if isinstance(tinput, dict) else None
                            if todos is not None:
                                out.append({"type": "todo_update", "todos": todos})
            elif ev_type == "UserMessage":
                for block in getattr(ev, "content", []) or []:
                    bt = type(block).__name__
                    if bt == "ToolResultBlock":
                        content = getattr(block, "content", "")
                        if isinstance(content, list):
                            parts = []
                            for b in content:
                                if isinstance(b, dict):
                                    parts.append(b.get("text", json.dumps(b)))
                                else:
                                    parts.append(getattr(b, "text", str(b)))
                            content = "".join(parts)
                        out.append({
                            "type": "tool_result",
                            "tool_use_id": getattr(block, "tool_use_id", ""),
                            "content": content if isinstance(content, str) else json.dumps(content),
                            "is_error": bool(getattr(block, "is_error", False)),
                        })
            elif ev_type == "ResultMessage":
                subtype = getattr(ev, "subtype", "")
                out.append({"type": "stop", "subtype": subtype or ""})
            elif ev_type == "SystemMessage":
                # Already handled (session_id) above
                pass
        except Exception as e:
            out.append({"type": "error", "msg": "translate: " + str(e)})
        return out

    # --- Main loop -------------------------------------------------------------
    async def run(self):
        self.stdin_queue = asyncio.Queue()
        loop = asyncio.get_event_loop()
        # First line MUST be init
        init_line = await loop.run_in_executor(None, sys.stdin.readline)
        if not init_line:
            emit({"type": "error", "msg": "no init line", "fatal": True})
            return
        try:
            init = json.loads(init_line)
        except Exception as e:
            emit({"type": "error", "msg": "bad init json: " + str(e), "fatal": True})
            return

        cwd = init.get("cwd") or "."
        resume_id = init.get("session_id") or None
        self.permission_mode = init.get("permission_mode") or "normal"

        # Mode "auto" (bypass interne) → on N'UTILISE PAS le flag dangereux
        # `--dangerously-skip-permissions` du SDK. À la place c'est notre hook
        # PreToolUse qui auto-allow tout (cf. self.permission_mode != "bypass").
        # Du coup côté SDK on reste en mode "default" ou "plan", point.
        sdk_mode = "plan" if self.permission_mode == "plan" else "default"
        try:
            options_kwargs = dict(
                cwd=cwd,
                setting_sources=["project"],
                permission_mode=sdk_mode,
                hooks={
                    "PreToolUse": [HookMatcher(hooks=[self.pre_tool_use])],
                    "PostToolUse": [HookMatcher(hooks=[self.post_tool_use])],
                },
                # Callback pour capturer le stderr du subprocess claude.
                # Sans ça le SDK ne forward jamais les vraies erreurs.
                stderr=self._on_claude_stderr,
                # Handler riche pour les "ask" (notamment AskUserQuestion qui
                # nécessite de retourner updated_input avec les answers).
                can_use_tool=self.can_use_tool,
            )
            if resume_id:
                options_kwargs["resume"] = resume_id
            options = ClaudeAgentOptions(**options_kwargs)
        except TypeError as e:
            emit({"type": "error", "msg": "ClaudeAgentOptions: " + str(e), "fatal": True})
            return

        asyncio.create_task(self.stdin_reader())

        try:
            async with ClaudeSDKClient(options=options) as client:
                self.client = client  # exposé pour interrupt depuis stdin_reader
                emit({"type": "ready"})
                emit({"type": "mode_changed", "mode": self.permission_mode})
                while True:
                    msg = await self.stdin_queue.get()
                    if msg is None:
                        warn("stdin EOF, exit")
                        break
                    t = msg.get("type")
                    # NOTE : 'interrupt' et 'set_permission_mode' sont traités
                    # directement dans stdin_reader (pas via cette queue), pour
                    # pouvoir passer pendant un receive_response en cours.
                    if t != "user_message":
                        continue
                    content = msg.get("content") or ""
                    try:
                        await client.query(content)
                        async for ev in client.receive_response():
                            for out in self.translate(ev):
                                emit(out)
                    except Exception as e:
                        emit({"type": "error", "msg": self._format_err("query", e)})
        except Exception as e:
            emit({"type": "error", "msg": self._format_err("client", e), "fatal": True})


def main():
    bridge = Bridge()
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        emit({"type": "error", "msg": bridge._format_err("top", e), "fatal": True})


if __name__ == "__main__":
    main()
