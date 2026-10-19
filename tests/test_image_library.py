import importlib
from pathlib import Path
import tempfile
import sys
from types import ModuleType, SimpleNamespace
import unittest

from aiohttp import web
from PIL import Image

package = ModuleType("henjicc_library_test")
package.__path__ = [str(Path(__file__).parents[1])]
sys.modules[package.__name__] = package
module = importlib.import_module(package.__name__ + ".library.image_library")


class ImageLibraryTests(unittest.TestCase):
    def test_resource_filters_metadata_and_video_thumbnail(self):
        import av
        import numpy as np
        from io import BytesIO
        with av.open(str(self.root / "clip.mp4"), "w") as container:
            stream = container.add_stream("mpeg4", rate=24)
            stream.width = 64; stream.height = 32; stream.pix_fmt = "yuv420p"
            for packet in stream.encode(av.VideoFrame.from_ndarray(np.full((32, 64, 3), 180, dtype=np.uint8), format="rgb24")):
                container.mux(packet)
            for packet in stream.encode(): container.mux(packet)
        (self.root / "sound.wav").write_bytes(b"not decoded by listing")
        self.assertEqual(self.library.list()["total"], 1)
        self.assertEqual(self.library.list(kind="all")["total"], 3)
        self.assertEqual(self.library.list(kind="video")["images"][0]["kind"], "video")
        self.assertEqual(self.library.list(kind="audio")["images"][0]["path"], "sound.wav")
        self.library.update(["clip.mp4", "sound.wav"], 4, ["素材"])
        self.assertEqual(self.library.list(kind="all", rating=4)["total"], 2)
        with Image.open(BytesIO(self.library.thumbnail("clip.mp4"))) as image:
            self.assertEqual(image.size, (64, 32))
        with self.assertRaises(ValueError): self.library.resolve("sound.wav")
        with self.assertRaises(ValueError): self.library.list(kind="unknown")
        with self.assertRaises(ValueError): self.library.resolve("../clip.mp4", extensions=module.RESOURCE_EXTENSIONS)

    def test_waveform_is_cached_and_invalidated_when_audio_changes(self):
        import wave
        import math
        import struct
        from io import BytesIO
        path=self.root / "tone.wav"
        def write_tone(frequency):
            with wave.open(str(path),"wb") as file:
                file.setnchannels(1);file.setsampwidth(2);file.setframerate(8000)
                file.writeframes(b"".join(struct.pack("<h",int(16000*math.sin(i*frequency/8000*math.tau))) for i in range(8000)))
        write_tone(440)
        data=self.library.thumbnail("tone.wav")
        with Image.open(BytesIO(data)) as image:
            self.assertEqual(image.size,(640,160))
        cache=self.library.database.parent / "cache" / "waveforms"
        first=list(cache.glob("*.webp"));self.assertEqual(len(first),1)
        stamp=first[0].stat().st_mtime_ns
        self.assertEqual(self.library.thumbnail("tone.wav"),data)
        self.assertEqual(first[0].stat().st_mtime_ns,stamp)
        write_tone(220)
        self.library.thumbnail("tone.wav")
        self.assertEqual(len(list(cache.glob("*.webp"))),2)
        (self.root / "bad.wav").write_bytes(b"bad")
        with self.assertRaisesRegex(ValueError,"波形"):
            self.library.thumbnail("bad.wav")
        with self.assertRaises(ValueError):self.library.thumbnail("../tone.wav")

    def test_batch_tag_actions_preserve_unrelated_tags_and_rollback_overflow(self):
        self.library.update(["红色.png"],tags=["old"])
        self.library.update(["红色.png"],tags=["new"],tag_action="add")
        self.assertEqual(self.library.list()["images"][0]["tags"],["old","new"])
        self.library.update(["红色.png"],tags=["old"],tag_action="remove")
        self.assertEqual(self.library.list()["images"][0]["tags"],["new"])
        self.library.update(["红色.png"],tags=[str(i) for i in range(32)])
        with self.assertRaises(ValueError):self.library.update(["红色.png"],rating=5,tags=["overflow"],tag_action="add")
        self.assertEqual(self.library.list()["images"][0]["rating"],0)
        with self.assertRaises(ValueError):self.library.update(["红色.png"],tags=[],tag_action="bad")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "input"
        self.root.mkdir()
        self.library = module.ImageLibrary(self.root, Path(self.temp.name) / "user" / "images.sqlite3")
        Image.new("RGB", (64, 32), "red").save(self.root / "红色.png")

    def test_nested_selection_and_invalid_paths(self):
        (self.root / "子目录").mkdir()
        Image.new("RGB", (32, 64)).save(self.root / "子目录" / "photo.png")
        self.assertEqual(self.library.resolve("子目录/photo.png").name, "photo.png")
        for path in ["../secret.png", "/etc/passwd", "C:/secret.png", "a\\b.png", ".hidden/image.png", "a//b.png", "a\x00.png", None]:
            with self.subTest(path=path), self.assertRaises((ValueError, FileNotFoundError)):
                self.library.resolve(path)
        self.assertEqual(self.library.list()["folders"][0]["path"], "子目录")

    def test_import_from_other_root_preserves_source_and_avoids_collisions(self):
        destination = Path(self.temp.name) / "another-input"
        destination.mkdir()
        first = self.library.import_to_input(["红色.png"], destination)[0]
        second = self.library.import_to_input(["红色.png"], destination)[0]
        self.assertNotEqual(first, second)
        self.assertEqual((destination / first).read_bytes(), (self.root / "红色.png").read_bytes())
        self.assertTrue((self.root / "红色.png").exists())
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.library.import_to_input(["红色.png", "../outside.png"], destination)
        self.assertEqual(len(list((destination / "henjicc/imports").iterdir())), 2)

    def test_import_rejects_oversized_files_before_copying(self):
        destination = Path(self.temp.name) / "another-input"
        destination.mkdir()
        with (self.root / "large.png").open("wb") as file:
            file.seek(512 * 1024 * 1024); file.write(b"x")
        with self.assertRaisesRegex(ValueError, "512 MB"):
            self.library.import_to_input(["large.png"], destination)
        self.assertFalse((destination / "henjicc").exists())

    def test_symlink_cannot_escape_root(self):
        outside = Path(self.temp.name) / "outside.png"
        Image.new("RGB", (10, 10)).save(outside)
        try:
            (self.root / "escape.png").symlink_to(outside)
        except OSError:
            self.skipTest("Creating symlinks is not permitted in this environment")
        with self.assertRaises(ValueError):
            self.library.resolve("escape.png")
        self.assertNotIn("escape.png", [i["name"] for i in self.library.list()["images"]])

    def test_metadata_persists_and_filters(self):
        self.library.update(["红色.png"], 4, ["人物", " 人物 ", "红色"])
        reopened = module.ImageLibrary(self.root, self.library.database)
        item = reopened.list(query="人物", rating=4)["images"][0]
        self.assertEqual(item["tags"], ["人物", "红色"])
        self.assertEqual(item["rating"], 4)
        self.assertEqual(reopened.list(rating=5)["total"], 0)
        with self.assertRaises(ValueError):
            reopened.update(["红色.png"], True)
        with self.assertRaises(ValueError):
            reopened.update(["红色.png"], tags="not a list")

    def test_pagination_and_deterministic_sort(self):
        for i in range(125):
            (self.root / f"{i:03}.png").write_bytes(b"not decoded by listing")
        first = self.library.list(sort="name", descending=False)
        second = self.library.list(sort="name", descending=False, offset=120)
        self.assertEqual(first["total"], 126)
        self.assertEqual(len(first["images"]), 120)
        self.assertEqual(len(second["images"]), 6)
        self.assertFalse({i["path"] for i in first["images"]} & {i["path"] for i in second["images"]})

    def test_thumbnail_invalidates_when_file_changes(self):
        first = self.library.thumbnail("红色.png")
        Image.new("RGB", (77, 65), "blue").save(self.root / "红色.png")
        second = self.library.thumbnail("红色.png")
        self.assertNotEqual(first, second)
        from io import BytesIO
        with Image.open(BytesIO(second)) as image:
            self.assertEqual(image.format, "WEBP")
            self.assertLessEqual(max(image.size), 320)

    def test_delete_validates_batch_before_removing_anything(self):
        with self.assertRaises(ValueError):
            self.library.delete(["红色.png", "../outside.png"])
        self.assertTrue((self.root / "红色.png").exists())
        self.library.update(["红色.png"], 3)
        self.assertEqual(self.library.delete(["红色.png"]), {"deleted": ["红色.png"], "failed": []})
        self.assertEqual(self.library.list()["total"], 0)


class RequestBoundaryTests(unittest.TestCase):
    def request(self, **overrides):
        args = dict(remote="127.0.0.1", host="127.0.0.1:8188", scheme="http", headers={}, method="GET", content_type="application/json")
        args.update(overrides)
        return SimpleNamespace(**args)

    def test_local_and_lan_same_origin(self):
        module.check_request(self.request())
        module.check_request(self.request(headers={"Origin": "http://127.0.0.1:8188"}))
        for remote, host in [("192.168.1.10", "192.168.1.20:8188"), ("10.1.2.3", "10.1.2.4:8188"),
                             ("172.16.2.3", "172.16.2.4:8188"), ("::ffff:192.168.1.10", "192.168.1.20:8188"),
                             ("fd00::2", "[fd00::1]:8188"), ("fe80::2", "[fe80::1]:8188"), ("::1", "localhost:8188")]:
            with self.subTest(remote=remote):
                for method in ("GET", "POST"):
                    module.check_request(self.request(remote=remote, host=host, method=method,
                        headers={"Origin": f"http://{host}", "Sec-Fetch-Site": "same-origin"}))

    def test_rejects_public_addresses_and_cross_origin(self):
        for request in [self.request(remote="8.8.8.8"), self.request(remote="2001:4860:4860::8888"),
                        self.request(remote="100.64.0.2"), self.request(host="8.8.8.8:8188"),
                        self.request(host="evil.example:8188"), self.request(host="[invalid:8188"),
                        self.request(remote=None), self.request(headers={"Origin": "https://evil.example"}),
                        self.request(headers={"Origin": "http://127.0.0.1:8189"}),
                        self.request(headers={"Origin": "https://127.0.0.1:8188"}), self.request(headers={"Origin": "null"}),
                        self.request(headers={"Sec-Fetch-Site": "cross-site"}), self.request(headers={"Sec-Fetch-Site": "same-site"}),
                        self.request(remote="8.8.8.8", headers={"X-Forwarded-For": "192.168.1.10"})]:
            with self.subTest(request=request), self.assertRaises(web.HTTPForbidden):
                module.check_request(request)

    def test_lan_writes_still_require_json(self):
        with self.assertRaises(web.HTTPUnsupportedMediaType):
            module.check_request(self.request(remote="192.168.1.10", host="192.168.1.20:8188", method="POST", content_type="text/plain"))


if __name__ == "__main__":
    unittest.main()
