import copy
import io
import json
import unittest
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import Mock, patch
from comparison import normalize_dataset, dataset_stats, validate_summary, MODELS, followup_bridge, request_equivalent, ComparisonApp, safe_api_event, BridgeFailure, result_metrics
import tkinter as tk


def payload():
    return {"format": "monada-summary-comparison", "version": 1, "date": "2026-11-18", "partialChats": 1,
            "clients": [], "statuses": [{"id": "waiting", "name": "Aguardando"}], "messages": [
                {"id": "one", "chatJid": "test@c.us", "chatName": "Teste", "senderName": "Pessoa", "fromMe": False,
                 "timestampMs": 1795003200000, "type": "chat", "text": "Mensagem sintética", "audio": None},
                {"id": "two", "chatJid": "test@c.us", "chatName": "Teste", "senderName": "Pessoa", "fromMe": True,
                 "timestampMs": 1795003260000, "type": "ptt", "text": "", "audio": {"status": "transcribed", "transcription": "Transcrição sintética", "dataUrl": "private-audio", "mediaKey": "private-key"}}]}


def summary():
    return {"summaries": [{"client_name": "Teste", "client_id": None, "general_summary": "Resumo sintético", "key_points": [],
                           "suggested_tasks": [{"description": "Demanda sintética", "responsibles": [], "status": "waiting", "observations": ""}]}]}


class ComparisonTests(unittest.TestCase):
    def test_import_preserves_authorship_and_transcription_without_media(self):
        data = normalize_dataset(payload())
        self.assertEqual(dataset_stats(data), {"messages": 2, "chats": 1, "audio": 1, "transcribed": 1})
        self.assertIs(data["messages"][1]["fromMe"], True)
        self.assertNotIn("private-", json.dumps(data))
        self.assertIn("Transcrição sintética", followup_bridge({"operation":"prepare", "data":data})["prompt"])

    def test_invalid_dates_duplicate_unknown_authorship_and_unreadable_text(self):
        for mutate in [lambda p: p.update(date="2026-11-19"), lambda p: p["messages"].append(copy.deepcopy(p["messages"][0])),
                       lambda p: p["messages"][0].update(fromMe=None), lambda p: p["messages"][0].update(text="")]:
            value = payload(); mutate(value)
            with self.assertRaises(ValueError): normalize_dataset(value)

    def test_production_input_is_sent_only_to_followup_gemini(self):
        value = payload(); value["messages"][1]["audio"] = {"status":"pending"}
        prepared = followup_bridge({"operation":"prepare", "data":normalize_dataset(value)})
        self.assertEqual(prepared["model"], "gemini-4-hydrogen")
        self.assertIn("1 áudio(s) não transcrito(s); geração parcial autorizada.", prepared["prompt"])
        self.assertIn("09:00:00 Pessoa:", prepared["prompt"])
        self.assertNotIn("test@c.us", prepared["prompt"])
        self.assertEqual(prepared["schema"]["properties"]["summaries"]["items"]["properties"]["clientIndex"], {"type":"null"})
        self.assertEqual(prepared["inputPolicy"],"compact-v1")
        self.assertEqual(prepared["optimization"]["excludedEmpty"],1)
        with patch("comparison.followup_bridge",return_value={"data":summary()}) as bridge:
            request_equivalent("Gemini do FollowUp",prepared,"synthetic-private-key")
            self.assertEqual(bridge.call_args[0][0],{"operation":"generate","prepared":prepared,"key":"synthetic-private-key","model":"gemini-4-hydrogen"})
        self.assertEqual(set(MODELS),{"Gemini do FollowUp","Gemini 3.8 Flash"})
        with patch("comparison.followup_bridge",return_value={"data":summary()}) as bridge:
            request_equivalent("Gemini 3.8 Flash",prepared,"synthetic-private-key")
            self.assertEqual(bridge.call_args[0][0]["model"],"gemini-3.8-flash")
            self.assertEqual(bridge.call_args[0][0]["prepared"],prepared)
        with patch("comparison.followup_bridge") as bridge:
            for removed in ("ERNIE","Nemotron","Gemini"):
                with self.assertRaises(RuntimeError):request_equivalent(removed,prepared,"test-key")
            bridge.assert_not_called()

    def test_bridge_failure_and_live_events_do_not_expose_content(self):
        process=Mock(stdin=io.StringIO(), stdout=io.StringIO("warning ignored\n" + json.dumps({"event":{"type":"http_response","number":1,"status":503,"private":"private-key"}}) + "\n" + json.dumps({"ok":False,"status":503})))
        process.wait.return_value=0; process.poll.return_value=0
        events=[]
        with patch("comparison.subprocess.Popen",return_value=process):
            with self.assertRaisesRegex(RuntimeError,"HTTP 503") as error:
                followup_bridge({"operation":"generate","key":"private-key"},progress=events.append)
        self.assertNotIn("private",str(error.exception))
        self.assertEqual(events,[{"type":"http_response","number":1,"status":503}])
        self.assertEqual(error.exception.status,503)
        self.assertIsNone(safe_api_event({"type":"http_start","number":True}))

    def test_local_timeout_terminates_child_and_has_specific_diagnostic(self):
        process=Mock(stdin=io.StringIO(),stdout=io.StringIO(""))
        process.wait.side_effect=[subprocess.TimeoutExpired("node",195),0]
        with patch("comparison.subprocess.Popen",return_value=process):
            with self.assertRaisesRegex(BridgeFailure,"195s") as error:followup_bridge({"operation":"generate"})
        self.assertEqual(error.exception.category,"timeout")
        process.kill.assert_called_once()

    def test_gemini_retry_prevents_overlap_and_exports_attempts_without_keys(self):
        root=tk.Tk(); root.withdraw()
        app=ComparisonApp(root, lambda:"secret-gemini", autoload=False)
        try:
            app.apply_data(normalize_dataset(payload()))
            app.prepared={"prompt":"synthetic", "schema":{}, "inputHash":"hash", "warnings":[], "model":"gemini-4-hydrogen", "settings":{"retry":"SDK oficial"}}
            with patch("comparison.threading.Thread") as thread:
                app.compare("Gemini do FollowUp")
                self.assertEqual(thread.call_count,1)
                self.assertEqual(app.pending,{"Gemini do FollowUp"})
                self.assertEqual(set(app.loaders),{"Gemini do FollowUp","Gemini 3.8 Flash"})
                app.compare("Gemini do FollowUp")
                self.assertEqual(thread.call_count,1)
            app.events.put(("Gemini do FollowUp",None,("api",{"type":"http_start","number":1})))
            app.events.put(("Gemini do FollowUp",None,("api",{"type":"http_response","number":1,"status":503})))
            app.poll()
            self.assertIn("HTTP: 503",app.metrics["Gemini do FollowUp"].get())
            self.assertIn("chamadas observadas: 1",app.metrics["Gemini do FollowUp"].get())
            self.assertGreaterEqual(app.attempts["Gemini do FollowUp"][-1]["elapsedWall"],0)
            app.events.put(("Gemini do FollowUp",None,"HTTP 503")); app.poll()
            app.results["Gemini 3.8 Flash"]={"data":summary()}
            app.pending.add("Gemini 3.8 Flash")
            app.running_since["Gemini 3.8 Flash"]=0
            app.attempts["Gemini 3.8 Flash"].append({"state":"running","apiEvents":[]})
            with patch("comparison.threading.Thread") as thread:
                app.compare("Gemini do FollowUp")
                self.assertEqual(thread.call_count,1)
            self.assertEqual(len(app.attempts["Gemini do FollowUp"]),2)
            self.assertIn("Gemini 3.8 Flash",app.results)
            self.assertIn("Gemini 3.8 Flash",app.pending)
            self.assertIn("Gemini do FollowUp",app.pending)
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/"report.json"
                with patch("comparison.filedialog.asksaveasfilename",return_value=str(path)):
                    app.export_report()
                exported=path.read_text(encoding="utf-8")
                report=json.loads(exported)
                self.assertEqual(len(report["attempts"]["Gemini do FollowUp"]),2)
                self.assertEqual(report["input"]["messages"][1]["audio"]["transcription"],"Transcrição sintética")
                self.assertNotIn("secret-gemini",exported); self.assertNotIn("secret-router",exported)
                self.assertEqual(len(app.panes.tabs()),2)
        finally: app.close()

    def test_both_models_launch_with_identical_prepared_input_and_distinct_model_records(self):
        root=tk.Tk(); root.withdraw(); app=ComparisonApp(root,lambda:"synthetic-key",autoload=False)
        try:
            app.apply_data(normalize_dataset(payload()))
            app.prepared={"prompt":"synthetic", "schema":{}, "inputHash":"same-input", "warnings":[], "model":"gemini-4-hydrogen", "settings":{"retry":"SDK oficial"}}
            with patch("comparison.threading.Thread") as thread:
                app.compare()
                self.assertEqual(thread.call_count,2)
                args=[call.kwargs["args"] for call in thread.call_args_list]
                self.assertEqual(args[0][1],args[1][1])
                self.assertEqual({args[0][0],args[1][0]},set(MODELS))
            self.assertEqual(app.pending,set(MODELS))
            self.assertEqual(app.attempts["Gemini 3.8 Flash"][0]["requestedModel"],"gemini-3.8-flash")
            self.assertEqual(app.attempts["Gemini do FollowUp"][0]["inputHash"],app.attempts["Gemini 3.8 Flash"][0]["inputHash"])
        finally:app.close()

    def test_success_without_optional_usage_renders_both_and_keeps_polling(self):
        root=tk.Tk();root.withdraw();app=ComparisonApp(root,lambda:"synthetic-key",autoload=False)
        try:
            app.apply_data(normalize_dataset(payload()))
            app.prepared={"prompt":"synthetic", "schema":{}, "inputHash":"same-input", "warnings":[], "model":"gemini-4-hydrogen", "settings":{}}
            with patch("comparison.threading.Thread"):app.compare()
            for provider in ("Gemini 3.8 Flash","Gemini do FollowUp"):
                result={"data":summary(),"model":MODELS[provider],"elapsed":1.2,"usage":{"input":10,"output":5}}
                app.events.put((provider,result,None))
            app.poll()
            self.assertEqual(app.pending,set())
            self.assertEqual(str(app.run_button["state"]),"normal")
            for provider in MODELS:
                self.assertIn("Resumo sintético",app.outputs[provider].get("1.0","end"))
                self.assertIn("raciocínio: não informado",app.metrics[provider].get())
                self.assertEqual(app.attempts[provider][-1]["state"],"completed")
            self.assertIn("não informado",result_metrics({"usage":None,"api":None}))
            self.assertIn("raciocínio: 0 tok",result_metrics({"usage":{"reasoning":0}}))
        finally:app.close()

    def test_saved_evaluation_recovers_result_without_any_api_call(self):
        root=tk.Tk();root.withdraw();app=ComparisonApp(root,lambda:"must-not-read-key",autoload=False)
        try:
            data=normalize_dataset(payload())
            report={"format":"monada-ai-evaluation","version":1,"input":data,"preparedInput":{"inputHash":"saved"},
                    "attempts":{"Gemini 3.8 Flash":[{"state":"completed","result":{"data":summary(),"model":"gemini-3.8-flash","usage":{"output":5}}}],
                                "Gemini do FollowUp":[{"state":"running"}]}}
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/"report.json";path.write_text(json.dumps(report),encoding="utf-8")
                with patch("comparison.filedialog.askopenfilename",return_value=str(path)),patch("comparison.request_equivalent") as api,patch("comparison.followup_bridge") as bridge:
                    app.open_report()
                api.assert_not_called();bridge.assert_not_called()
            self.assertIn("Resumo sintético",app.outputs["Gemini 3.8 Flash"].get("1.0","end"))
            self.assertEqual(app.pending,set())
            self.assertEqual(app.archived_prepared,{"inputHash":"saved"})
            self.assertIsNone(app.prepared)
        finally:app.close()

    def test_poc_is_supported_without_claiming_transcriptions(self):
        source = payload()
        source["messages"][1]["audio"] = {"status": "recovered", "dataUrl": "private-audio"}
        data = normalize_dataset({"days": [{"date": "2026-11-18", "conversations": [{"messages": source["messages"]}]}]})
        self.assertEqual(dataset_stats(data)["transcribed"], 0)
        self.assertIn("PoC", data["source"])

    def test_response_validation_rejects_invented_client_or_status(self):
        data = normalize_dataset(payload())
        self.assertEqual(validate_summary(summary(), data), summary())
        value = summary(); value["summaries"][0]["client_id"] = "unknown"
        with self.assertRaises(ValueError): validate_summary(value, data)
        value = summary(); value["summaries"][0]["suggested_tasks"][0]["status"] = "unknown"
        with self.assertRaises(ValueError): validate_summary(value, data)


if __name__ == "__main__": unittest.main()
