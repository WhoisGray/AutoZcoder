"""Commit hygiene contracts use path strings, never create real secret files."""
import subprocess
import sys
from pathlib import Path

import pytest

ROOT=Path(__file__).resolve().parents[1]


def test_secret_variants_and_binaries_are_ignored_but_examples_visible():
    excluded=['.env.production','nested/.env.local','mail-worker/.dev.vars',
              'mail-worker/.dev.vars.production','tools/captcha-mint/captcha-mint',
              'tools/captcha-mint/captcha-mint.exe','ZcodeGateway.new.exe.sha256']
    result=subprocess.run(['git','check-ignore','--stdin'],cwd=ROOT,
                          input=('\n'.join(excluded)+'\n').encode(),capture_output=True,check=False)
    assert set(result.stdout.decode().splitlines())==set(excluded)
    for example in ['.env.example','.env.sample']:
        assert subprocess.run(['git','check-ignore',example],cwd=ROOT,
                              capture_output=True).returncode==1


def test_proxy_source_override_is_optional_not_machine_specific():
    text=(ROOT/'generator/proxy_pool.py').read_text(encoding='utf-8')
    assert "os.environ.get('KICKVIEW_SOURCES', '')" in text
    assert 'D:\\JB\\' not in text


def test_sidecar_regressions_are_ci_and_release_gates():
    import json
    package=json.loads((ROOT/'tools/captcha-mint/package.json').read_text())
    assert package['scripts']['test']=='bun test audit.test.ts'
    for workflow in ['ci.yml','release.yml']:
        text=(ROOT/'.github/workflows'/workflow).read_text()
        assert 'bun run test' in text
        assert 'bun install --frozen-lockfile' in text


def test_local_outputs_ignored_but_canonical_build_scripts_visible():
    for name in ('.local/runtime/config.yaml','.local/dist/ZcodeGateway.exe','.local/build/specs/ZcodeGateway.spec'):
        assert subprocess.run(['git','check-ignore',name],cwd=ROOT,capture_output=True).returncode==0
    for name in ('scripts/build/windows.ps1','scripts/build/linux.sh','scripts/build/macos.sh',
                 'scripts/packaging/stage_mail_worker.py','scripts/accounts/import_account.py',
                 'requirements/server.txt','requirements/macos.txt'):
        assert (ROOT/name).is_file()
        assert subprocess.run(['git','check-ignore',name],cwd=ROOT,capture_output=True).returncode==1


def test_source_checkout_bootstrap_isolated_from_repository_root(tmp_path,monkeypatch):
    from zcode_gateway import paths
    import yaml
    checkout=tmp_path/'checkout';checkout.mkdir();(checkout/'.git').mkdir()
    monkeypatch.setattr(paths,'app_dir',lambda:checkout)
    monkeypatch.setattr(paths.sys,'frozen',False,raising=False)
    monkeypatch.setenv('ZCODE_GATEWAY_CONFIG','')
    config=paths.bootstrap_config()
    assert config==checkout/'.local/runtime/config.yaml'
    assert not (checkout/'config.yaml').exists()
    assert (config.parent/'accounts').is_dir()
    assert yaml.safe_load(config.read_text())['server']['admin_key']


def test_frozen_macos_app_keeps_data_beside_the_bundle(tmp_path, monkeypatch):
    from zcode_gateway import paths
    bundle = tmp_path / "Apps" / "ZcodeGateway.app" / "Contents" / "MacOS"
    bundle.mkdir(parents=True)
    exe = bundle / "ZcodeGateway"
    exe.write_bytes(b"")
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(paths.sys, "platform", "darwin")
    monkeypatch.setattr(paths.sys, "executable", str(exe))
    assert paths.app_dir() == tmp_path / "Apps"


def test_frozen_macos_terminal_binary_keeps_data_beside_the_file(tmp_path, monkeypatch):
    from zcode_gateway import paths
    folder = tmp_path / "bin"
    folder.mkdir()
    exe = folder / "ZcodeGateway-macos"
    exe.write_bytes(b"")
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(paths.sys, "platform", "darwin")
    monkeypatch.setattr(paths.sys, "executable", str(exe))
    assert paths.app_dir() == folder


def test_macos_per_user_dir_uses_application_support(monkeypatch):
    from zcode_gateway import paths
    monkeypatch.setattr(paths.sys, "platform", "darwin")
    monkeypatch.setattr(paths.os, "name", "posix")
    assert paths._per_user_dir() == paths.Path.home() / "Library" / "Application Support" / "ZcodeGateway"


def test_macos_single_instance_lock_is_a_file(tmp_path, monkeypatch):
    if sys.platform == "win32":
        pytest.skip("POSIX lock")
    import gui_main
    monkeypatch.setattr("zcode_gateway.paths._per_user_dir", lambda: tmp_path)
    monkeypatch.setattr(gui_main, "_instance_lock", None)
    assert gui_main._already_running() is False
    assert (tmp_path / "single-instance.lock").is_file()
