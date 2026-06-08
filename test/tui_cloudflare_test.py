from __future__ import annotations

import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch


def install_tui_import_stubs() -> None:
    qrcode = types.ModuleType("qrcode")

    class QRCode:
        def __init__(self, *args, **kwargs):
            pass

        def add_data(self, value):
            pass

        def make(self, fit=True):
            pass

        def get_matrix(self):
            return [[False, False], [False, False]]

    qrcode.QRCode = QRCode
    qrcode.constants = types.SimpleNamespace(ERROR_CORRECT_M=0)
    sys.modules.setdefault("qrcode", qrcode)

    textual = types.ModuleType("textual")
    textual_app = types.ModuleType("textual.app")
    textual_containers = types.ModuleType("textual.containers")
    textual_widgets = types.ModuleType("textual.widgets")

    class Dummy:
        @classmethod
        def __class_getitem__(cls, item):
            return cls

        def __init__(self, *args, **kwargs):
            self.id = kwargs.get("id")
            self.value = kwargs.get("value", "")

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def update(self, *args, **kwargs):
            pass

        def query_one(self, *args, **kwargs):
            return Dummy()

        def call_from_thread(self, func, *args, **kwargs):
            return func(*args, **kwargs)

    textual_app.App = Dummy
    textual_app.ComposeResult = object
    for name in ("Horizontal", "Vertical", "VerticalScroll"):
        setattr(textual_containers, name, Dummy)
    for name in ("Button", "Footer", "Header", "Input", "Static", "TabbedContent", "TabPane"):
        setattr(textual_widgets, name, Dummy)

    sys.modules.setdefault("textual", textual)
    sys.modules.setdefault("textual.app", textual_app)
    sys.modules.setdefault("textual.containers", textual_containers)
    sys.modules.setdefault("textual.widgets", textual_widgets)


install_tui_import_stubs()
dexyd_tui = importlib.import_module("tui.dexyd_tui")


class CloudflareTunnelHelpersTest(unittest.TestCase):
    def test_numbered_name_and_hostname_candidates(self) -> None:
        self.assertEqual(dexyd_tui.normalized_tunnel_name(" dexyd bridge! "), "dexyd-bridge")
        self.assertEqual(dexyd_tui.numbered_name("dexyd", 1), "dexyd")
        self.assertEqual(dexyd_tui.numbered_name("dexyd", 2), "dexyd-2")
        self.assertEqual(dexyd_tui.numbered_hostname("dexyd.example.com", 3), "dexyd-3.example.com")

    def test_ensure_available_tunnel_skips_taken_tunnel_name(self) -> None:
        uuid = "22222222-2222-4222-8222-222222222222"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            creds_dir = home / ".cloudflared"
            creds_dir.mkdir(parents=True)
            (creds_dir / f"{uuid}.json").write_text("{}", encoding="utf-8")
            log_dir = root / ".dexyd" / "cloudflared"

            commands: list[list[str]] = []

            def fake_run(command: list[str], timeout: int = 30, env=None):
                commands.append(command)
                if command[1:3] == ["tunnel", "create"]:
                    return CompletedProcess(command, 0, f"Created tunnel {uuid}\n", "")
                if command[1:4] == ["tunnel", "route", "dns"]:
                    return CompletedProcess(command, 0, "DNS route created", "")
                return CompletedProcess(command, 0, "", "")

            with patch.object(dexyd_tui, "CLOUDFLARE_LOG_DIR", log_dir), \
                patch.object(dexyd_tui, "CLOUDFLARE_CONFIG_FILE", log_dir / "config.yml"), \
                patch.object(dexyd_tui, "CLOUDFLARE_METADATA_FILE", log_dir / "tunnel.json"), \
                patch.object(dexyd_tui.Path, "home", return_value=home), \
                patch.object(dexyd_tui, "list_cloudflare_tunnels", return_value=[{"name": "dexyd", "id": "11111111-1111-4111-8111-111111111111"}]), \
                patch.object(dexyd_tui, "run_capture", side_effect=fake_run):
                setup = dexyd_tui.ensure_available_cloudflare_tunnel(
                    "/usr/bin/cloudflared", "dexyd", "dexyd.example.com", "http://127.0.0.1:4242"
                )

            self.assertEqual(setup.tunnel_name, "dexyd-2")
            self.assertEqual(setup.hostname, "dexyd-2.example.com")
            self.assertEqual(setup.public_url, "https://dexyd-2.example.com")
            self.assertTrue((log_dir / "config.yml").exists())
            metadata = dexyd_tui.json.loads((log_dir / "tunnel.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["requestedTunnelName"], "dexyd")
            self.assertEqual(metadata["tunnelName"], "dexyd-2")
            self.assertIn(["/usr/bin/cloudflared", "tunnel", "route", "dns", "dexyd-2", "dexyd-2.example.com"], commands)

    def test_ensure_available_tunnel_increments_hostname_after_dns_conflict(self) -> None:
        first_uuid = "11111111-1111-4111-8111-111111111111"
        second_uuid = "22222222-2222-4222-8222-222222222222"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            creds_dir = home / ".cloudflared"
            creds_dir.mkdir(parents=True)
            (creds_dir / f"{first_uuid}.json").write_text("{}", encoding="utf-8")
            (creds_dir / f"{second_uuid}.json").write_text("{}", encoding="utf-8")
            log_dir = root / ".dexyd" / "cloudflared"
            created = iter([first_uuid, second_uuid])
            deleted: list[str] = []

            def fake_run(command: list[str], timeout: int = 30, env=None):
                if command[1:3] == ["tunnel", "create"]:
                    uuid = next(created)
                    return CompletedProcess(command, 0, f"Created tunnel {uuid}\n", "")
                if command[1:4] == ["tunnel", "route", "dns"]:
                    hostname = command[-1]
                    if hostname == "dexyd.example.com":
                        return CompletedProcess(command, 1, "", "DNS record already exists")
                    return CompletedProcess(command, 0, "DNS route created", "")
                if command[1:3] == ["tunnel", "delete"]:
                    deleted.append(command[-1])
                    return CompletedProcess(command, 0, "", "")
                return CompletedProcess(command, 0, "", "")

            with patch.object(dexyd_tui, "CLOUDFLARE_LOG_DIR", log_dir), \
                patch.object(dexyd_tui, "CLOUDFLARE_CONFIG_FILE", log_dir / "config.yml"), \
                patch.object(dexyd_tui, "CLOUDFLARE_METADATA_FILE", log_dir / "tunnel.json"), \
                patch.object(dexyd_tui.Path, "home", return_value=home), \
                patch.object(dexyd_tui, "list_cloudflare_tunnels", return_value=[]), \
                patch.object(dexyd_tui, "run_capture", side_effect=fake_run):
                setup = dexyd_tui.ensure_available_cloudflare_tunnel(
                    "/usr/bin/cloudflared", "dexyd", "dexyd.example.com", "http://127.0.0.1:4242"
                )

            self.assertEqual(deleted, [first_uuid])
            self.assertEqual(setup.tunnel_id, second_uuid)
            self.assertEqual(setup.tunnel_name, "dexyd-2")
            self.assertEqual(setup.hostname, "dexyd-2.example.com")
            config = dexyd_tui.yaml.safe_load((log_dir / "config.yml").read_text(encoding="utf-8"))
            self.assertEqual(config["tunnel"], second_uuid)
            self.assertEqual(config["credentials-file"], str(creds_dir / f"{second_uuid}.json"))
            self.assertEqual(config["ingress"][0], {"hostname": "dexyd-2.example.com", "service": "http://127.0.0.1:4242"})


if __name__ == "__main__":
    unittest.main()
