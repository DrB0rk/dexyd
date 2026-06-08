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
    textual_screen = types.ModuleType("textual.screen")

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
    textual_screen.ModalScreen = Dummy
    for name in ("Horizontal", "Vertical", "VerticalScroll"):
        setattr(textual_containers, name, Dummy)
    for name in ("Button", "Footer", "Header", "Input", "Static", "TabbedContent", "TabPane"):
        setattr(textual_widgets, name, Dummy)

    sys.modules.setdefault("textual", textual)
    sys.modules.setdefault("textual.app", textual_app)
    sys.modules.setdefault("textual.containers", textual_containers)
    sys.modules.setdefault("textual.screen", textual_screen)
    sys.modules.setdefault("textual.widgets", textual_widgets)


install_tui_import_stubs()
dexyd_tui = importlib.import_module("tui.dexyd_tui")


class CloudflareTunnelHelpersTest(unittest.TestCase):
    def test_numbered_name_and_hostname_candidates(self) -> None:
        self.assertEqual(dexyd_tui.normalized_tunnel_name(" dexyd bridge! "), "dexyd-bridge")
        self.assertEqual(dexyd_tui.numbered_name("dexyd", 1), "dexyd")
        self.assertEqual(dexyd_tui.numbered_name("dexyd", 2), "dexyd-2")
        self.assertEqual(dexyd_tui.numbered_hostname("dexyd.example.com", 3), "dexyd-3.example.com")

    def test_ensure_available_tunnel_requires_confirmation_for_taken_tunnel_name(self) -> None:
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
                with self.assertRaises(dexyd_tui.CloudflareDuplicateError):
                    dexyd_tui.ensure_available_cloudflare_tunnel(
                        "/usr/bin/cloudflared", "dexyd", "dexyd.example.com", "http://127.0.0.1:4242"
                    )

            self.assertFalse((log_dir / "config.yml").exists())
            self.assertNotIn(["/usr/bin/cloudflared", "tunnel", "route", "dns", "dexyd", "dexyd.example.com"], commands)

    def test_ensure_available_tunnel_overwrites_name_and_dns_when_confirmed(self) -> None:
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
            created = iter([second_uuid])
            deleted: list[str] = []
            commands: list[list[str]] = []

            def fake_run(command: list[str], timeout: int = 30, env=None):
                commands.append(command)
                if command[1:3] == ["tunnel", "create"]:
                    uuid = next(created)
                    return CompletedProcess(command, 0, f"Created tunnel {uuid}\n", "")
                if command[1:4] == ["tunnel", "route", "dns"]:
                    return CompletedProcess(command, 0, "DNS route created", "")
                if command[1:3] == ["tunnel", "delete"]:
                    deleted.append(command[-1])
                    return CompletedProcess(command, 0, "", "")
                return CompletedProcess(command, 0, "", "")

            with patch.object(dexyd_tui, "CLOUDFLARE_LOG_DIR", log_dir), \
                patch.object(dexyd_tui, "CLOUDFLARE_CONFIG_FILE", log_dir / "config.yml"), \
                patch.object(dexyd_tui, "CLOUDFLARE_METADATA_FILE", log_dir / "tunnel.json"), \
                patch.object(dexyd_tui.Path, "home", return_value=home), \
                patch.object(dexyd_tui, "list_cloudflare_tunnels", return_value=[{"name": "dexyd", "id": first_uuid}]), \
                patch.object(dexyd_tui, "run_capture", side_effect=fake_run):
                setup = dexyd_tui.ensure_available_cloudflare_tunnel(
                    "/usr/bin/cloudflared",
                    "dexyd",
                    "dexyd.example.com",
                    "http://127.0.0.1:4242",
                    overwrite=True,
                )

            self.assertEqual(deleted, [first_uuid])
            self.assertEqual(setup.tunnel_id, second_uuid)
            self.assertEqual(setup.tunnel_name, "dexyd")
            self.assertEqual(setup.hostname, "dexyd.example.com")
            self.assertIn(["/usr/bin/cloudflared", "tunnel", "route", "dns", "--overwrite-dns", "dexyd", "dexyd.example.com"], commands)
            config = dexyd_tui.yaml.safe_load((log_dir / "config.yml").read_text(encoding="utf-8"))
            self.assertEqual(config["tunnel"], second_uuid)
            self.assertEqual(config["credentials-file"], str(creds_dir / f"{second_uuid}.json"))
            self.assertEqual(config["ingress"][0], {"hostname": "dexyd.example.com", "service": "http://127.0.0.1:4242"})


    def test_saved_dexyd_tunnel_can_change_hostname_without_name_overwrite(self) -> None:
        uuid = "33333333-3333-4333-8333-333333333333"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            creds_dir = home / ".cloudflared"
            creds_dir.mkdir(parents=True)
            (creds_dir / f"{uuid}.json").write_text("{}", encoding="utf-8")
            log_dir = root / ".dexyd" / "cloudflared"
            log_dir.mkdir(parents=True)
            (log_dir / "tunnel.json").write_text(
                dexyd_tui.json.dumps(
                    {
                        "tunnelId": uuid,
                        "tunnelName": "dexyd",
                        "requestedTunnelName": "dexyd",
                        "hostname": "old.example.com",
                        "publicUrl": "https://old.example.com",
                    }
                ),
                encoding="utf-8",
            )
            commands: list[list[str]] = []

            def fake_run(command: list[str], timeout: int = 30, env=None):
                commands.append(command)
                if command[1:4] == ["tunnel", "route", "dns"]:
                    return CompletedProcess(command, 0, "DNS route created", "")
                raise AssertionError(f"unexpected command: {command}")

            with patch.object(dexyd_tui, "CLOUDFLARE_LOG_DIR", log_dir), \
                patch.object(dexyd_tui, "CLOUDFLARE_CONFIG_FILE", log_dir / "config.yml"), \
                patch.object(dexyd_tui, "CLOUDFLARE_METADATA_FILE", log_dir / "tunnel.json"), \
                patch.object(dexyd_tui.Path, "home", return_value=home), \
                patch.object(dexyd_tui, "list_cloudflare_tunnels", return_value=[{"name": "dexyd", "id": uuid}]), \
                patch.object(dexyd_tui, "run_capture", side_effect=fake_run):
                setup = dexyd_tui.ensure_available_cloudflare_tunnel(
                    "/usr/bin/cloudflared", "dexyd", "new.example.com", "http://127.0.0.1:4242"
                )

            self.assertEqual(setup.tunnel_id, uuid)
            self.assertTrue(setup.reused_existing)
            self.assertEqual(setup.hostname, "new.example.com")
            self.assertIn(["/usr/bin/cloudflared", "tunnel", "route", "dns", "dexyd", "new.example.com"], commands)
            self.assertNotIn(["/usr/bin/cloudflared", "tunnel", "delete", "-f", uuid], commands)
            metadata = dexyd_tui.json.loads((log_dir / "tunnel.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["hostname"], "new.example.com")

    def test_dns_conflict_without_overwrite_asks_for_confirmation(self) -> None:
        uuid = "11111111-1111-4111-8111-111111111111"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            creds_dir = home / ".cloudflared"
            creds_dir.mkdir(parents=True)
            (creds_dir / f"{uuid}.json").write_text("{}", encoding="utf-8")
            log_dir = root / ".dexyd" / "cloudflared"

            def fake_run(command: list[str], timeout: int = 30, env=None):
                if command[1:3] == ["tunnel", "create"]:
                    return CompletedProcess(command, 0, f"Created tunnel {uuid}\n", "")
                if command[1:4] == ["tunnel", "route", "dns"]:
                    return CompletedProcess(command, 1, "", "DNS record already exists")
                if command[1:3] == ["tunnel", "delete"]:
                    return CompletedProcess(command, 0, "", "")
                return CompletedProcess(command, 0, "", "")

            with patch.object(dexyd_tui, "CLOUDFLARE_LOG_DIR", log_dir), \
                patch.object(dexyd_tui, "CLOUDFLARE_CONFIG_FILE", log_dir / "config.yml"), \
                patch.object(dexyd_tui, "CLOUDFLARE_METADATA_FILE", log_dir / "tunnel.json"), \
                patch.object(dexyd_tui.Path, "home", return_value=home), \
                patch.object(dexyd_tui, "list_cloudflare_tunnels", return_value=[]), \
                patch.object(dexyd_tui, "run_capture", side_effect=fake_run):
                with self.assertRaises(dexyd_tui.CloudflareDuplicateError):
                    dexyd_tui.ensure_available_cloudflare_tunnel(
                        "/usr/bin/cloudflared", "dexyd", "dexyd.example.com", "http://127.0.0.1:4242"
                    )

            self.assertFalse((log_dir / "config.yml").exists())


if __name__ == "__main__":
    unittest.main()
