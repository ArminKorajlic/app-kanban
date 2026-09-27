"""The JSON-v1 entry: safe to preload, and one identity lookup per few minutes."""

import ast
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_entry():
  spec = importlib.util.spec_from_file_location('kanban_service_entry', ROOT / 'service.py')
  module = importlib.util.module_from_spec(spec)
  sys.path.insert(0, str(ROOT))
  try:
    spec.loader.exec_module(module)
  finally:
    sys.path.remove(str(ROOT))
  return module


class Response:
  def __init__(self, status_code, body=None):
    self.status_code = status_code
    self._body = body or {}

  def json(self):
    return self._body


class ServiceEntryTests(unittest.TestCase):
  def test_preloaded_module_setup_needs_no_request_credential_and_starts_no_threads(self):
    # MOBIUS_PRELOAD lets Möbius run module setup once, without APP_TOKEN, and
    # fork each request from it; the per-request block must stay last.
    tree = ast.parse((ROOT / 'service.py').read_text())
    self.assertEqual(ast.unparse(tree.body[-1].test), "__name__ == '__main__'")
    self.assertIn('MOBIUS_PRELOAD = True', [ast.unparse(node) for node in tree.body])
    env = {key: value for key, value in os.environ.items() if key != 'APP_TOKEN'}
    probe = subprocess.run(
      [sys.executable, '-c',
       'import threading, service; assert service.MOBIUS_PRELOAD is True; '
       'assert threading.active_count() == 1, threading.enumerate()'],
      cwd=ROOT, env=env, text=True, capture_output=True,
    )
    self.assertEqual(probe.returncode, 0, probe.stderr)

  def test_owner_label_is_remembered_refreshed_and_kept_through_outages(self):
    entry = load_entry()
    replies = []

    class Client:
      def __init__(self, **_kwargs):
        pass

      async def __aenter__(self):
        return self

      async def __aexit__(self, *_args):
        return False

      async def get(self, url, headers):
        reply = replies.pop(0)
        if isinstance(reply, Exception):
          raise reply
        return reply

    clock = [1_000.0]
    with tempfile.TemporaryDirectory() as storage, patch.dict(os.environ, {
      'APP_STORAGE_DIR': storage, 'API_BASE_URL': 'http://127.0.0.1:9', 'APP_TOKEN': 't',
    }), patch.object(entry.httpx, 'AsyncClient', Client), patch.object(
      entry.time, 'time', lambda: clock[0],
    ):
      replies.append(Response(200, {'profile': {'handle': 'owner'}}))
      self.assertEqual(asyncio.run(entry.owner_label()), '@owner')
      # Within the TTL no request is made at all.
      clock[0] += entry.OWNER_LABEL_TTL_S - 1
      self.assertEqual(asyncio.run(entry.owner_label()), '@owner')
      self.assertEqual(replies, [])
      # After it, a rename is picked up.
      clock[0] += 2
      replies.append(Response(200, {'profile': {'handle': 'renamed'}}))
      self.assertEqual(asyncio.run(entry.owner_label()), '@renamed')
      # An outage keeps the last known label instead of the host name.
      clock[0] += entry.OWNER_LABEL_TTL_S + 1
      replies.extend([Response(503), OSError('down')])
      self.assertEqual(asyncio.run(entry.owner_label()), '@renamed')
      self.assertEqual(asyncio.run(entry.owner_label()), '@renamed')
      saved = json.loads((Path(storage) / 'server' / 'owner-label.json').read_text())
      self.assertEqual(saved['label'], '@renamed')


if __name__ == '__main__':
  unittest.main()
