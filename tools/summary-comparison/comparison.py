"""Comparação local e independente de resumos diários: Gemini do FollowUp."""
from __future__ import annotations

import hashlib
import json
import math
import queue
import subprocess
import copy
import re
import threading
import time
import tkinter as tk
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk

MODELS = {"Gemini do FollowUp": "gemini-4-hydrogen", "Gemini 3.8 Flash": "gemini-3.8-flash"}
PROJECT_ROOT = Path(r"C:\Users\taian\Documents\antigravity\FollowUpMonada")

DEFAULT_DATE = "2026-11-18"
DEFAULT_STATUSES = [{"id": "aguardando cliente", "name": "Aguardando cliente"}, {"id": "em produção", "name": "Em produção"}, {"id": "resolvido", "name": "Resolvido"}]



def business_datetime(milliseconds):
    if isinstance(milliseconds, bool) or not isinstance(milliseconds, (float, int)) or not math.isfinite(milliseconds):
        raise ValueError("Horário de mensagem inválido.")
    utc = datetime.fromtimestamp(milliseconds / 1000, timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo("America/Sao_Paulo")
    except (ImportError, KeyError):
        # Windows pode não ter tzdata. Neste intervalo o Brasil não usa horário de verão.
        if not 2020 <= utc.year <= 2026:
            raise ValueError("Instale tzdata para interpretar esta data em America/Sao_Paulo.")
        zone = timezone(timedelta(hours=-3), "America/Sao_Paulo")
    return utc.astimezone(zone)


def clean_records(records):
    if not isinstance(records, list) or len(records) > 5000:
        raise ValueError("Cadastros inválidos.")
    result = []
    for record in records:
        if not isinstance(record, dict) or not all(isinstance(record.get(key), str) and len(record[key]) <= 500 for key in ("id", "name")):
            raise ValueError("Cadastro inválido.")
        result.append({"id": record["id"], "name": record["name"]})
    return result


def normalize_dataset(payload, selected_date=DEFAULT_DATE):
    date.fromisoformat(selected_date)
    if not isinstance(payload, dict):
        raise ValueError("Arquivo de conversas inválido.")
    legacy = payload.get("format") != "monada-summary-comparison"
    if legacy:
        day = next((d for d in payload.get("days", []) if d.get("date") == selected_date), None)
        if day is None:
            raise ValueError("Esta data não existe no relatório da PoC.")
        raw_messages = [m for chat in day.get("conversations", []) for m in chat.get("messages", [])]
        coverage = day.get("messageCoverage") or {}
        partial = len(coverage.get("possiblyTruncatedConversations") or [])
        clients, statuses = [], DEFAULT_STATUSES
    else:
        if payload.get("version") != 1 or payload.get("date") != selected_date:
            raise ValueError("Selecione a mesma data do arquivo exportado (formato versão 1).")
        raw_messages = payload.get("messages")
        partial = payload.get("partialChats", 0)
        clients = clean_records(payload.get("clients", []))
        statuses = clean_records(payload.get("statuses", [])) or DEFAULT_STATUSES
    if not isinstance(raw_messages, list) or not 1 <= len(raw_messages) <= 10000:
        raise ValueError("O arquivo deve conter de 1 a 10 mil mensagens da data.")
    if isinstance(partial, bool) or not isinstance(partial, int) or not 0 <= partial <= len(raw_messages):
        raise ValueError("Informação de histórico parcial inválida.")
    messages, seen, excluded = [], set(), 0
    for raw in raw_messages:
        if not isinstance(raw, dict):
            raise ValueError("Mensagem inválida.")
        jid = raw.get("chatJid", "")
        kind = str(raw.get("type", "chat")).lower()
        if jid == "status@broadcast" or kind in ("protocol", "message_edit_encrypted"):
            excluded += 1
            continue
        if not isinstance(jid, str) or not re.fullmatch(r"[^\s/@]+@(c\.us|s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)", jid):
            raise ValueError("Identificador de conversa inválido.")
        identifier = raw.get("id")
        if not isinstance(identifier, str) or not identifier or identifier in seen:
            raise ValueError("Mensagem sem identificador ou duplicada.")
        seen.add(identifier)
        if type(raw.get("fromMe")) is not bool:
            raise ValueError("Mensagem sem autoria confirmada.")
        moment = business_datetime(raw.get("timestampMs"))
        if moment.date().isoformat() != selected_date:
            raise ValueError("Mensagem fora da data selecionada em America/Sao_Paulo.")
        text = raw.get("text", "")
        if not isinstance(text, str) or len(text) > 20000 or (kind in ("chat", "extended_text") and not text.strip()):
            raise ValueError("Texto ausente/ilegível ou maior que o limite. Exporte a importação atual pelo Mônada.")
        audio = raw.get("audio")
        is_audio = kind in ("audio", "ptt") or isinstance(audio, dict)
        transcript = audio.get("transcription") if isinstance(audio, dict) and audio.get("status") == "transcribed" else None
        if transcript is not None and (not isinstance(transcript, str) or len(transcript) > 20000):
            raise ValueError("Transcrição inválida.")
        record = {"id": identifier, "chatJid": jid, "timestampMs": raw["timestampMs"], "fromMe": raw["fromMe"], "type": kind, "text": text,
                  "audio": {"transcription": transcript.strip() if transcript else None} if is_audio else None}
        for field in ("chatName", "senderName", "senderJid"):
            value = raw.get(field) or (jid if field == "chatName" else "")
            if not isinstance(value, str) or len(value) > 500:
                raise ValueError("Nome/identificação inválido.")
            record[field] = value
        messages.append(record)
    if not messages:
        raise ValueError("Nenhuma conversa válida para comparar.")
    messages.sort(key=lambda m: (m["timestampMs"], m["id"]))
    return {"date": selected_date, "messages": messages, "clients": clients, "statuses": statuses,
            "partialChats": partial, "source": "PoC local (sem cadastros do Mônada)" if legacy else "Importação da extensão Mônada",
            "excluded": excluded, "transcribeAudio": payload.get("transcribeAudio", True)}


def load_dataset(path, selected_date=DEFAULT_DATE):
    file = Path(path)
    if file.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Arquivo excede 32 MiB. Exporte somente a data desejada pelo Mônada.")
    payload = json.loads(file.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError("Arquivo de conversas inválido.")
    if payload.get("format") == "monada-summary-comparison" and file.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("A exportação de uma data excede 8 MiB.")
    return normalize_dataset(payload, selected_date)


def dataset_stats(data):
    messages = data["messages"]
    audio = [m for m in messages if m["audio"] is not None]
    return {"messages": len(messages), "chats": len({m["chatJid"] for m in messages}), "audio": len(audio),
            "transcribed": sum(bool(m["audio"]["transcription"]) for m in audio)}


def conversation_text(data):
    lines = []
    for message in data["messages"]:
        if message["audio"] is not None:
            transcript = message["audio"]["transcription"]
            text = "[Áudio transcrito] " + transcript if transcript else "[Áudio não transcrito; conteúdo não incluído]"
        else:
            text = message["text"]
        lines.append(f'{business_datetime(message["timestampMs"]).strftime("%d/%m/%Y %H:%M:%S")} | {message["chatName"]} ({message["chatJid"]}) | {"Você" if message["fromMe"] else message["senderName"]}: {text}')
    return "\n".join(lines)


def validate_summary(value, data):
    if not isinstance(value, dict) or not isinstance(value.get("summaries"), list):
        raise ValueError("A resposta não contém a lista summaries.")
    statuses = {s["id"] for s in data["statuses"]}
    clients = {c["id"] for c in data["clients"]}
    for item in value["summaries"]:
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) and item[k].strip() for k in ("client_name", "general_summary")):
            raise ValueError("Cliente/resumo inválido na resposta.")
        if "client_id" not in item or (item["client_id"] is not None and (not isinstance(item["client_id"], str) or item["client_id"] not in clients)):
            raise ValueError("O modelo retornou um cliente que não consta do cadastro.")
        if not isinstance(item.get("key_points"), list) or not all(isinstance(v, str) for v in item["key_points"]):
            raise ValueError("Pontos principais inválidos.")
        if not isinstance(item.get("suggested_tasks"), list):
            raise ValueError("Demandas inválidas.")
        for task in item["suggested_tasks"]:
            if not isinstance(task, dict) or not isinstance(task.get("description"), str) or not task["description"].strip() or not isinstance(task.get("status"), str) or task["status"] not in statuses:
                raise ValueError("Descrição/status de demanda inválido.")
            if not isinstance(task.get("responsibles"), list) or not all(isinstance(v, str) for v in task["responsibles"]) or not isinstance(task.get("observations"), str):
                raise ValueError("Responsáveis/contexto de demanda inválidos.")
    return value


def render_summary(summary, data):
    names = {s["id"]: s["name"] for s in data["statuses"]}
    lines = []
    for client in summary["summaries"]:
        lines += ["# " + client["client_name"], "", client["general_summary"], "", "Pontos principais:"]
        lines += ["• " + point for point in client["key_points"]]
        lines += ["", "Demandas sugeridas:"]
        for task in client["suggested_tasks"]:
            lines += ["• " + task["description"], "  Responsáveis: " + (", ".join(task["responsibles"]) or "Não citados"), "  Status: " + names[task["status"]]]
            if task["observations"]:
                lines += ["  Contexto/prazo: " + task["observations"]]
        lines += ["", "─" * 45, ""]
    return "\n".join(lines) or "Nenhum resumo/demanda retornado. Confira se o conteúdo justificava esse resultado."



class BridgeFailure(RuntimeError):
    def __init__(self, message, status=None, category="provider"):
        super().__init__(message)
        self.status, self.category = status, category


def safe_api_event(event):
    if not isinstance(event, dict) or event.get("type") not in ("http_start", "http_response"):
        return None
    if type(event.get("number")) is not int or not 1 <= event["number"] <= 100:
        return None
    result = {"type": event["type"], "number": event["number"]}
    status = event.get("status")
    if type(status) is int and 100 <= status <= 599: result["status"] = status
    for field in ("headersElapsed", "retryAfterSeconds"):
        value = event.get(field)
        if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 100000: result[field] = value
    if event.get("networkFailure") is True: result["networkFailure"] = True
    return result


def followup_bridge(payload, progress=None):
    script = PROJECT_ROOT / "tools/summary-comparison/followup-bridge.mjs"
    process, reader = None, None
    envelopes = []
    try:
        process = subprocess.Popen(["node", str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8", creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0), cwd=PROJECT_ROOT)
        def read_output():
            try:
                for line in process.stdout:
                    # Bound each local protocol record; never forward arbitrary stdout/stderr.
                    if len(line) > 8 * 1024 * 1024: continue
                    try: envelope = json.loads(line)
                    except (ValueError, TypeError): continue
                    if not isinstance(envelope,dict): continue
                    event = safe_api_event(envelope.get("event"))
                    if event and progress: progress(event)
                    elif "ok" in envelope: envelopes.append(envelope)
            except Exception:
                pass
        reader = threading.Thread(target=read_output, daemon=True); reader.start()
        process.stdin.write(json.dumps(payload, ensure_ascii=False)); process.stdin.close()
        process.wait(timeout=195)
        reader.join(timeout=2)
        if not envelopes: raise ValueError("Resposta local ausente.")
        envelope = envelopes[-1]
    except subprocess.TimeoutExpired:
        if process: process.kill(); process.wait(timeout=5)
        raise BridgeFailure("Limite local de 195s atingido. A espera foi encerrada; a API pode ter recebido a chamada. Exporte a avaliação antes de repetir.", category="timeout") from None
    except Exception:
        if process and process.poll() is None: process.kill(); process.wait(timeout=5)
        raise BridgeFailure("Não foi possível executar o fluxo local do FollowUp. Confira Node.js e a pasta do projeto.", category="local") from None
    finally:
        if process:
            if process.stdin and not process.stdin.closed: process.stdin.close()
            if process.stdout: process.stdout.close()
    if not envelope.get("ok"):
        status = envelope.get("status")
        status = status if type(status) is int and 100 <= status <= 599 else None
        detail = {429:"Cota/limite de uso atingido.",503:"Serviço temporariamente indisponível.",401:"Autenticação recusada.",403:"Permissão recusada.",402:"Pagamento/créditos exigidos."}.get(status,"Confira a configuração ou tente novamente.")
        raise BridgeFailure("Gemini/FollowUp: " + (f"HTTP {status}. " if status else "Falha na geração. ") + detail, status=status) from None
    return envelope["result"]


def request_equivalent(provider, prepared, api_key, progress=None):
    if provider not in MODELS or not api_key:
        raise RuntimeError("Modelo/chave inválidos. Use um dos modelos Gemini configurados.")
    return followup_bridge({"operation": "generate", "prepared": prepared, "key": api_key, "model": MODELS[provider]}, **({"progress":progress} if progress else {}))


def result_metrics(result):
    # Usage fields are optional in Gemini responses. Missing never means zero.
    usage = result.get("usage") or {}
    api = result.get("api") or {}
    def count(values, field):
        value = values.get(field)
        return str(value) if type(value) in (int, float) and math.isfinite(value) and value >= 0 else "não informado"
    elapsed = result.get("elapsed")
    elapsed_text = f"{elapsed:.2f}s" if type(elapsed) in (int, float) and math.isfinite(elapsed) else "tempo não informado"
    return (f"{elapsed_text} | entrada: {count(usage, 'input')} tok | saída: {count(usage, 'output')} tok | "
            f"raciocínio: {count(usage, 'reasoning')} tok | {result.get('model') or 'modelo não informado'} | "
            f"término: {result.get('finishReason') or 'não informado'} | HTTP: {count(api, 'observedHttpCalls')} chamada(s) | "
            f"cache: {count(api, 'cachedTokens')} tok | total: {count(api, 'totalTokens')} tok")


class ComparisonApp:
    def __init__(self, root, gemini_key, groq_key=None, legacy_class=None, autoload=True, openrouter_key=None):
        self.root, self.loaders, self.legacy_class = root, {provider: gemini_key for provider in MODELS}, legacy_class
        self.attempts, self.prepared = {p: [] for p in MODELS}, None
        self.data, self.results, self.pending = None, {}, set()
        self.archived_prepared = None
        self.events = queue.Queue()
        self.closed = False
        self.running_since = {}
        root.title("Resumo diário — Hydrogen × Gemini 3.8 Flash")
        root.geometry("1120x850")
        root.minsize(660, 540)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.columnconfigure(0, weight=1); root.rowconfigure(0, weight=1)
        frame = ttk.Frame(root, padding=12); self.frame = frame; frame.grid(sticky="nsew"); frame.columnconfigure(0, weight=1); frame.rowconfigure(4, weight=1)
        bar = ttk.Frame(frame); bar.grid(row=0, sticky="ew"); bar.columnconfigure(4, weight=1)
        ttk.Label(bar, text="Data (AAAA-MM-DD):").grid(row=0, column=0, padx=3)
        self.date_var = tk.StringVar(value=DEFAULT_DATE)
        self.date_entry = ttk.Entry(bar, textvariable=self.date_var, width=12); self.date_entry.grid(row=0, column=1, padx=3)
        self.load_button = ttk.Button(bar, text="Importar conversas do Mônada", command=self.import_file); self.load_button.grid(row=0, column=2, padx=3)
        self.report_button = ttk.Button(bar, text="Abrir avaliação salva (sem usar API)", command=self.open_report)
        self.report_button.grid(row=1, column=0, columnspan=4, sticky="ew", pady=(6, 0))
        self.source = tk.StringVar(value="Importe o JSON em Consultar Conversas > Exportar para comparar IAs, no Mônada.")
        ttk.Label(frame, textvariable=self.source, wraplength=1000).grid(row=1, sticky="ew", pady=6)
        self.preview = scrolledtext.ScrolledText(frame, height=7, wrap=tk.WORD, font=("Segoe UI", 10)); self.preview.grid(row=2, sticky="nsew")
        controls = ttk.Frame(frame); controls.grid(row=3, sticky="ew", pady=8); controls.columnconfigure(0, weight=1)
        self.run_button = ttk.Button(controls, text="Gerar nos dois modelos", command=self.compare); self.run_button.grid(row=0, column=0, sticky="ew")
        self.export_button = ttk.Button(controls, text="Exportar avaliação completa", command=self.export_report); self.export_button.grid(row=0, column=1, padx=6)
        self.panes = ttk.Notebook(frame); self.panes.grid(row=4, sticky="nsew")
        self.outputs, self.metrics, self.boxes, self.retry_buttons = {}, {}, {}, {}
        for column, provider in enumerate(MODELS):
            box = ttk.LabelFrame(self.panes, text=MODELS[provider], padding=6); self.panes.add(box, text=provider)
            box.columnconfigure(0, weight=1); box.rowconfigure(1, weight=1)
            metric = tk.StringVar(value="Aguardando"); ttk.Label(box, textvariable=metric, wraplength=480).grid(row=0, sticky="ew")
            output = scrolledtext.ScrolledText(box, wrap=tk.WORD, font=("Segoe UI", 10)); output.grid(row=1, sticky="nsew")
            ttk.Button(box, text="Copiar este resultado", command=lambda p=provider: self.copy(p)).grid(row=2, sticky="ew", pady=(6, 0))
            retry = ttk.Button(box, text="Repetir somente este modelo", command=lambda p=provider: self.compare(p)); retry.grid(row=3, sticky="ew", pady=4)
            self.retry_buttons[provider] = retry
            self.outputs[provider], self.metrics[provider], self.boxes[provider] = output, metric, box
        settings_text = "SDK oficial | raciocínio LOW | temperatura padrão | sem streaming | 60s por tentativa / 180s total | plano, saldo e custo não são informados pela resposta"
        ttk.Label(frame, text=settings_text, wraplength=1000).grid(row=7, sticky="ew")
        self.status = tk.StringVar(value="Hydrogen × Gemini 3.8 Flash: mesma entrada compacta, schema, LOW e retries oficiais. Duas chamadas independentes usando sua chave Gemini.")
        ttk.Label(frame, textvariable=self.status, wraplength=1000).grid(row=5, sticky="ew", pady=6)
        ttk.Label(frame, text="Resultados, tempos e tokens separados por modelo, com o mesmo hash de entrada. Exportação inclui todas as tentativas e conversas usadas, sem chaves. Resultados ficam somente em memória.", wraplength=1000).grid(row=6, sticky="ew")
        root.bind("<Configure>", self.resize)
        root.after(150, self.poll)
        if autoload:
            root.after(300, self.load_initial)

    def resize(self, event):
        if event.widget is not self.root:
            return
        narrow = event.width < 900
        for child in self.frame.winfo_children():
            if isinstance(child, ttk.Label): child.configure(wraplength=max(320, event.width - 40))
        for provider in MODELS:
            for child in self.boxes[provider].winfo_children():
                if isinstance(child, ttk.Label): child.configure(wraplength=max(220, event.width - 65))

    def load_initial(self):
        downloads = Path.home() / "Downloads"
        exported = sorted(downloads.glob(f"monada-comparacao-{DEFAULT_DATE}*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        choices = exported or sorted(downloads.glob("monada-wa-poc-rodada-3-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in choices:
            try:
                self.apply_data(load_dataset(path, DEFAULT_DATE)); return
            except (ValueError, OSError, KeyError, OverflowError):
                continue

    def apply_data(self, data):
        self.data, self.results = data, {}
        self.archived_prepared = None
        self.attempts, self.prepared = {p: [] for p in MODELS}, None
        self.date_var.set(data["date"])
        counts = dataset_stats(data)
        warning = f' | ATENÇÃO: {counts["audio"] - counts["transcribed"]} áudio(s) sem transcrição; conteúdo não incluído no resumo.' if counts["audio"] > counts["transcribed"] else ""
        self.source.set(f'{data["source"]} | {data["date"]} | {counts["chats"]} conversas | {counts["messages"]} mensagens | {counts["transcribed"]}/{counts["audio"]} áudios transcritos{warning}')
        self.preview.configure(state="normal"); self.preview.delete("1.0", tk.END); self.preview.insert("1.0", conversation_text(data)); self.preview.configure(state="disabled")
        for provider in MODELS:
            self.outputs[provider].delete("1.0", tk.END); self.metrics[provider].set("Aguardando")

    def import_file(self):
        if self.pending:
            return
        path = filedialog.askopenfilename(initialdir=Path.home() / "Downloads", filetypes=[("Conversas JSON", "*.json")])
        if path:
            try:
                self.apply_data(load_dataset(path, self.date_var.get()))
            except Exception:
                messagebox.showerror("Não foi possível importar", "Confira a data selecionada e o formato do arquivo. Use a exportação do Mônada ou um relatório da PoC com essa data.", parent=self.root)

    def open_report(self):
        if self.pending: return
        path = filedialog.askopenfilename(initialdir=Path.home() / "Downloads", filetypes=[("Avaliação JSON", "*.json")])
        if not path: return
        try:
            file = Path(path)
            if file.stat().st_size > 16 * 1024 * 1024: raise ValueError("Arquivo excedido.")
            report = json.loads(file.read_text(encoding="utf-8-sig"))
            if report.get("format") != "monada-ai-evaluation" or report.get("version") != 1: raise ValueError("Formato inválido.")
            raw = report["input"]
            data = normalize_dataset({**raw, "format":"monada-summary-comparison", "version":1}, raw["date"])
            attempts = report.get("attempts", {})
            restored = {}
            for provider in MODELS:
                history = attempts.get(provider, [])
                if not isinstance(history, list) or len(history) > 1000: raise ValueError("Histórico inválido.")
                for attempt in history:
                    if not isinstance(attempt, dict): raise ValueError("Tentativa inválida.")
                    result = attempt.get("result")
                    if result is not None:
                        if not isinstance(result, dict): raise ValueError("Resultado inválido.")
                        validate_summary(result.get("data"), data)
                restored[provider] = history
            # Validate everything before replacing current in-memory data. No API/SDK call.
            self.apply_data(data)
            self.attempts = restored
            self.archived_prepared = report.get("preparedInput") if isinstance(report.get("preparedInput"), dict) else None
            for provider, history in restored.items():
                if not history: continue
                completed = next((a["result"] for a in reversed(history) if a.get("result") is not None), None)
                if completed:
                    self.results[provider] = completed
                    self.metrics[provider].set(result_metrics(completed))
                    self.outputs[provider].insert("1.0", render_summary(completed["data"], data))
                elif history[-1].get("state") == "running":
                    self.metrics[provider].set("O arquivo não contém resultado concluído para este modelo.")
                else:
                    self.metrics[provider].set("Tentativa anterior falhou; consulte o relatório ou repita este modelo.")
            self.status.set("Avaliação salva aberta sem usar a API. Resultados disponíveis foram recuperados; uma nova geração prepara a entrada atual novamente.")
        except Exception:
            messagebox.showerror("Não foi possível abrir", "Confira o formato e a integridade da avaliação exportada.", parent=self.root)

    def compare(self, only=None):
        targets = [only] if only in MODELS else list(MODELS)
        targets = [p for p in targets if p not in self.pending]
        if not targets:
            return
        if self.data is None or self.date_var.get() != self.data["date"]:
            messagebox.showwarning("Importe a data", "Importe o arquivo da data selecionada antes de comparar.", parent=self.root); return
        try:
            if self.prepared is None:
                prepared = followup_bridge({"operation": "prepare", "data": self.data})
                if prepared["model"] != MODELS["Gemini do FollowUp"]:
                    MODELS["Gemini do FollowUp"] = prepared["model"]
                    self.boxes["Gemini do FollowUp"].configure(text=prepared["model"])
                self.prepared = prepared
            keys = {provider: self.loaders[provider]() for provider in targets}
        except Exception:
            messagebox.showerror("Configuração inválida", "Confira Node.js, a pasta do projeto, GEMINI_API_KEY. Nenhum dado foi enviado.", parent=self.root); return
        if self.prepared["warnings"] and not messagebox.askyesno("Comparar com conteúdo incompleto?", " ".join(self.prepared["warnings"]) + " Continuar?", parent=self.root):
            return
        for provider in targets:
            self.pending.add(provider)
            self.running_since[provider] = time.perf_counter()
            self.outputs[provider].delete("1.0", tk.END)
            self.metrics[provider].set("Gerando resposta integral…")
            self.retry_buttons[provider].configure(state="disabled")
            # Frozen input allows a failed provider to be repeated while the other runs.
            record = {"number": len(self.attempts[provider]) + 1, "startedAt": datetime.now(timezone.utc).isoformat(),
                      "state": "running", "requestedModel": MODELS[provider], "inputHash": self.prepared["inputHash"],
                      "settings": copy.deepcopy(self.prepared["settings"]), "apiEvents": [], "elapsedWall": 0}
            self.attempts[provider].append(record)
            threading.Thread(target=self.worker, args=(provider, copy.deepcopy(self.prepared), keys[provider], copy.deepcopy(self.data)), daemon=True).start()
        for widget in (self.load_button, self.report_button, self.run_button, self.date_entry): widget.configure(state="disabled")
        optimization = self.prepared.get("optimization", {})
        self.status.set(f"Referência do Mônada: {self.prepared['model']} | SDK: {self.prepared.get('sdkVersion', 'não informado')} | entrada: {len(self.prepared['prompt'])} caracteres | mensagens úteis: {optimization.get('includedMessages', 'não informado')} | canais omitidos: {optimization.get('excludedNewsletters', 0)} | mídias vazias: {optimization.get('excludedEmpty', 0)} | referências: {optimization.get('repeatedReferences', 0)} | sem streaming. O tempo inclui rede e retries.")

    def worker(self, provider, prepared, key, data):
        try:
            result = request_equivalent(provider, prepared, key, progress=lambda event: self.events.put((provider, None, ("api", event))))
            result["data"] = validate_summary(result["data"], data)
            self.events.put((provider, result, None))
        except Exception as error:
            safe = str(error) if isinstance(error, RuntimeError) else "Resposta inválida ou falha de validação; detalhes internos omitidos."
            self.events.put((provider, None, {"message":safe,"status":getattr(error,"status",None),"category":getattr(error,"category","validation")}))

    def export_report(self):
        if self.data is None:
            messagebox.showwarning("Sem dados", "Importe as conversas antes de exportar.", parent=self.root); return
        path = filedialog.asksaveasfilename(defaultextension=".json", initialfile=f"avaliacao-ias-{self.data['date']}.json", filetypes=[("Avaliação completa (contém conversas pessoais)", "*.json")])
        if not path: return
        # Explicit allowlist: loaders, keys, environment and provider payloads are never serialized.
        report = {"format": "monada-ai-evaluation", "version": 1, "exportedAt": datetime.now(timezone.utc).isoformat(),
                  "input": self.data, "preparedInput": self.prepared or self.archived_prepared, "archivedPreparedInput": self.archived_prepared, "attempts": self.attempts,
                  "notice": "Contém conversas/transcrições e cadastros pessoais. Teste do fluxo atual, não reprodução garantida do resumo histórico. Gemini usa SDK oficial. Tempos incluem retries e envio de rede."}
        try:
            Path(path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            self.status.set("Avaliação completa exportada. O arquivo contém conversas pessoais; anexe-o somente onde desejar compartilhar.")
        except OSError:
            messagebox.showerror("Falha ao exportar", "Não foi possível gravar o arquivo escolhido.", parent=self.root)

    def poll(self):
        if self.closed:
            return
        while not self.events.empty():
            provider, result, error = self.events.get_nowait()
            if isinstance(error, tuple):
                event = safe_api_event(error[1])
                if event: self.attempts[provider][-1]["apiEvents"].append(event)
                continue
            self.pending.discard(provider)
            elapsed_wall = time.perf_counter() - self.running_since.pop(provider, time.perf_counter())
            self.retry_buttons[provider].configure(state="normal")
            attempt = self.attempts[provider][-1]
            attempt.update(state="failed" if error else "completed", finishedAt=datetime.now(timezone.utc).isoformat(), result=result, error=error, elapsedWall=elapsed_wall)
            if error:
                self.outputs[provider].insert("1.0", error.get("message", "Falha na API.") if isinstance(error,dict) else error); self.metrics[provider].set(f"Falhou após {elapsed_wall:.1f}s; use Repetir somente este modelo")
            else:
                self.results[provider] = result
                self.metrics[provider].set(result_metrics(result))
                self.outputs[provider].insert("1.0", render_summary(result["data"], self.data))
        
        for provider in self.pending:
            attempt = self.attempts[provider][-1]
            elapsed = time.perf_counter() - self.running_since[provider]
            attempt["elapsedWall"] = round(elapsed, 2)
            calls = [e for e in attempt.get("apiEvents", []) if e["type"] == "http_start"]
            responses = [e for e in attempt.get("apiEvents", []) if e["type"] == "http_response"]
            latest = responses[-1] if responses else {}
            http = latest.get("status", "ainda não recebido")
            stage = "Aguardando resposta integral" if len(calls) > len(responses) else "SDK processando resposta" if http == 200 else "SDK entre chamadas; retry pode ocorrer" if calls else "Preparando SDK local"
            self.metrics[provider].set(f"{elapsed:.1f}s | {stage} | HTTP: {http} | chamadas observadas: {len(calls)} | limite API: 180s; espera local: 195s")
        if not self.pending and str(self.run_button["state"]) == "disabled":
            for widget in (self.load_button, self.report_button, self.run_button, self.date_entry): widget.configure(state="normal")
            self.status.set("Comparação encerrada. Avalie omissões, clientes, responsáveis, prazos e demandas inventadas; formato válido não garante fidelidade.")
        self.root.after(150, self.poll)

    def copy(self, provider):
        self.root.clipboard_clear(); self.root.clipboard_append(self.outputs[provider].get("1.0", tk.END))

    def close(self):
        self.closed = True; self.root.destroy()
