"""Browse ComfyUI media roots. Never accepts arbitrary filesystem roots."""

import asyncio
from contextlib import contextmanager
from functools import lru_cache, wraps
from io import BytesIO
import ipaddress
import json
import logging
from pathlib import Path
import sqlite3
import uuid
from urllib.parse import urlsplit

from aiohttp import web
from PIL import Image, ImageOps, UnidentifiedImageError

EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
RESOURCE_EXTENSIONS = EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS


def resource_extensions(kind):
    choices = {"image": EXTENSIONS, "video": VIDEO_EXTENSIONS, "audio": AUDIO_EXTENSIONS, "all": RESOURCE_EXTENSIONS}
    if kind not in choices:
        raise ValueError("素材类型无效")
    return choices[kind]


def resource_kind(path):
    suffix = Path(path).suffix.lower()
    return "video" if suffix in VIDEO_EXTENSIONS else "audio" if suffix in AUDIO_EXTENSIONS else "image"
PREFIX = "/henjicc/image-library"
LAN_NETWORKS = tuple(ipaddress.ip_network(network) for network in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "fe80::/10",
))
log = logging.getLogger(__name__)


class ImageLibrary:
    def __init__(self, root, database):
        self.root = Path(root).resolve()
        self.database = Path(database)

    def import_to_input(self, paths, input_root):
        if not isinstance(paths, list) or not 1 <= len(paths) <= 24:
            raise ValueError("最多添加 24 个素材")
        sources = [self.resolve(path, extensions=RESOURCE_EXTENSIONS) for path in paths]
        limit = 512 * 1024 * 1024
        if any(path.stat().st_size > limit for path in sources):
            raise ValueError("单个素材不能超过 512 MB")
        root = Path(input_root).resolve(strict=True)
        destination = (root / "henjicc" / "imports").resolve()
        if not destination.is_relative_to(root):
            raise ValueError("路径超出输入目录")
        destination.mkdir(parents=True, exist_ok=True)
        destination = destination.resolve(strict=True)
        if not destination.is_relative_to(root):
            raise ValueError("路径超出输入目录")
        created = []
        try:
            for source in sources:
                target = destination / f"{uuid.uuid4().hex}-{source.name}"
                with source.open("rb") as reader, target.open("xb") as writer:
                    created.append(target)
                    size = 0
                    while chunk := reader.read(1024 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise ValueError("单个素材不能超过 512 MB")
                        writer.write(chunk)
            return [path.relative_to(root).as_posix() for path in created]
        except Exception:
            for path in created:
                path.unlink(missing_ok=True)
            raise

    def resolve(self, relative, *, directory=False, extensions=EXTENSIONS):
        if not isinstance(relative, str) or len(relative) > 2048:
            raise ValueError("图片路径无效")
        if "\\" in relative or ":" in relative or "\x00" in relative:
            raise ValueError("请使用输入目录内的相对路径")
        parts = relative.split("/") if relative else []
        if any(not p or p in {".", ".."} or p.startswith(".") for p in parts):
            raise ValueError("不能访问隐藏路径或上级目录")
        candidate = self.root.joinpath(*parts).resolve(strict=True)
        if not candidate.is_relative_to(self.root):
            raise ValueError("路径超出输入目录")
        if directory:
            if not candidate.is_dir():
                raise ValueError("不是文件夹")
        elif not candidate.is_file() or candidate.suffix.lower() not in extensions:
            raise ValueError("不是支持的图片")
        return candidate

    @contextmanager
    def connect(self):
        self.database.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.database, timeout=5)
        try:
            with conn:
                conn.execute("CREATE TABLE IF NOT EXISTS images (path TEXT PRIMARY KEY, rating INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]')")
                yield conn
        finally:
            conn.close()

    def list(self, directory="", query="", sort="date", descending=True, rating=0, offset=0, kind="image"):
        extensions = resource_extensions(kind)
        folder = self.resolve(directory, directory=True)
        with self.connect() as conn:
            metadata = {row[0]: (row[1], json.loads(row[2])) for row in conn.execute("SELECT path, rating, tags FROM images")}
        folders, images = [], []
        for entry in folder.iterdir():
            if entry.name.startswith("."):
                continue
            relative = "/".join(filter(None, [directory, entry.name]))
            try:
                if entry.is_dir():
                    self.resolve(relative, directory=True)
                    folders.append({"name": entry.name, "path": relative})
                    continue
                path = self.resolve(relative, extensions=extensions)
                stat = path.stat()
            except (ValueError, OSError):
                continue
            stars, tags = metadata.get(relative, (0, []))
            if stars < rating or query.casefold() not in (entry.name + " " + " ".join(tags)).casefold():
                continue
            images.append({"name": entry.name, "path": relative, "mtime": stat.st_mtime_ns,
                           "size": stat.st_size, "rating": stars, "tags": tags, "kind": resource_kind(path)})
        if sort not in {"name", "date", "rating"}:
            raise ValueError("排序方式无效")
        key = {"name": lambda i: i["name"].casefold(), "date": lambda i: (i["mtime"], i["name"]),
               "rating": lambda i: (i["rating"], i["name"].casefold())}[sort]
        images.sort(key=key, reverse=descending)
        return {"directory": directory, "folders": sorted(folders, key=lambda i: i["name"].casefold()),
                "images": images[offset:offset + 120], "total": len(images), "offset": offset}

    def update(self, paths, rating=None, tags=None, tag_action="replace"):
        if not isinstance(paths, list) or not 1 <= len(paths) <= 120:
            raise ValueError("每次请选择 1–120 张图片")
        if rating is not None and (type(rating) is not int or not 0 <= rating <= 5):
            raise ValueError("评分必须为 0–5")
        if tag_action not in {"replace", "add", "remove"}:
            raise ValueError("标签操作无效")
        if tags is not None:
            if not isinstance(tags, list) or len(tags) > 32 or any(not isinstance(t, str) or len(t) > 64 for t in tags):
                raise ValueError("标签最多 32 个，每个不超过 64 字")
            tags = list(dict.fromkeys(t.strip() for t in tags if t.strip()))
        for path in paths:
            self.resolve(path, extensions=RESOURCE_EXTENSIONS)
        with self.connect() as conn:
            for path in paths:
                conn.execute("INSERT OR IGNORE INTO images(path) VALUES (?)", (path,))
                if rating is not None:
                    conn.execute("UPDATE images SET rating=? WHERE path=?", (rating, path))
                if tags is not None:
                    current = json.loads(conn.execute("SELECT tags FROM images WHERE path=?", (path,)).fetchone()[0])
                    result = tags if tag_action == "replace" else list(dict.fromkeys(current + tags)) if tag_action == "add" else [tag for tag in current if tag not in tags]
                    if len(result) > 32:
                        raise ValueError("标签最多 32 个，每个不超过 64 字")
                    conn.execute("UPDATE images SET tags=? WHERE path=?", (json.dumps(result, ensure_ascii=False), path))

    def delete(self, paths):
        if not isinstance(paths, list) or not 1 <= len(paths) <= 120:
            raise ValueError("每次请选择 1–120 张图片")
        # Validate the entire batch before deleting any file. Report partial I/O failures.
        for path in paths:
            self.resolve(path, extensions=RESOURCE_EXTENSIONS)
        deleted, failed = [], []
        with self.connect() as conn:
            for path in dict.fromkeys(paths):
                try:
                    self.resolve(path, extensions=RESOURCE_EXTENSIONS).unlink()
                    conn.execute("DELETE FROM images WHERE path=?", (path,))
                    deleted.append(path)
                except (OSError, ValueError):
                    failed.append(path)
        return {"deleted": deleted, "failed": failed}

    def thumbnail(self, relative):
        path = self.resolve(relative, extensions=RESOURCE_EXTENSIONS)
        stat = path.stat()
        if path.suffix.lower() in AUDIO_EXTENSIONS:
            from .audio_waveform import waveform
            return waveform(path, self.database.parent / "cache" / "waveforms")
        return thumbnail_bytes(str(path), stat.st_mtime_ns, stat.st_size)

    def info(self, relative):
        with Image.open(self.resolve(relative)) as image:
            width, height = image.size
            if image.getexif().get(274) in {5, 6, 7, 8}:
                width, height = height, width
            return {"path": relative, "width": width, "height": height, "frames": getattr(image, "n_frames", 1)}


@lru_cache(maxsize=128)
def thumbnail_bytes(path, modified, size):
    # Stat values invalidate cached thumbnails after replacement without hashing full images.
    if Path(path).suffix.lower() in VIDEO_EXTENSIONS:
        import av
        if size > 512 * 1024**2:
            raise ValueError("单个素材不能超过 512 MB")
        with av.open(path) as container:
            if not container.streams.video:
                raise ValueError("视频没有画面")
            stream = container.streams.video[0]
            if stream.width * stream.height > 32 * 1024**2:
                raise ValueError("视频分辨率过大")
            frame = next(container.decode(video=0), None)
            if frame is None:
                raise ValueError("视频没有可读帧")
            if frame.width * frame.height > 32 * 1024**2:
                raise ValueError("视频分辨率过大")
            image = frame.to_image()
            if frame.rotation:
                image = image.rotate(frame.rotation, expand=True)
            image.thumbnail((320, 320))
            output = BytesIO()
            image.save(output, format="WEBP", quality=80)
            return output.getvalue()
    with Image.open(path) as image:
        image.seek(0)
        image = ImageOps.exif_transpose(image)
        image.thumbnail((320, 320))
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        output = BytesIO()
        image.save(output, format="WEBP", quality=80)
        return output.getvalue()


def local_or_lan_address(value):
    try:
        address = ipaddress.ip_address(value or "")
    except ValueError:
        return False
    address = getattr(address, "ipv4_mapped", None) or address
    return address.is_loopback or any(address in network for network in LAN_NETWORKS)


def check_request(request):
    try:
        host = urlsplit("http://" + request.host).hostname
    except ValueError:
        host = None
    if host != "localhost" and not local_or_lan_address(host):
        raise web.HTTPForbidden(text="请使用 localhost 或局域网 IP 地址访问图片库")
    # Use the actual peer, never client-controlled forwarding headers.
    if not local_or_lan_address(request.remote):
        raise web.HTTPForbidden(text="图片库仅允许本机或局域网访问")
    origin = request.headers.get("Origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            same_origin = parsed.scheme == request.scheme and parsed.netloc == request.host
        except ValueError:
            same_origin = False
        if not same_origin:
            raise web.HTTPForbidden(text="不允许跨站访问图片库")
    if request.headers.get("Sec-Fetch-Site") not in {None, "same-origin", "none"}:
        raise web.HTTPForbidden(text="不允许跨站访问图片库")
    if request.method == "POST" and request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType(text="需要 JSON 请求")


def register_routes():
    import folder_paths
    from server import PromptServer

    server = PromptServer.instance
    semaphore = asyncio.Semaphore(4)

    def endpoint(fn):
        @wraps(fn)
        async def handle(request):
            try:
                check_request(request)
                source = request.query.get("source", "input")
                if source not in {"input", "output", "temp"}:
                    raise ValueError("素材目录类型无效")
                suffix = "" if source == "input" else f"-{source}"
                database = server.user_manager.get_request_user_filepath(request, f"henjicc/image-library{suffix}.sqlite3")
                if not database:
                    raise web.HTTPForbidden()
                library = ImageLibrary(folder_paths.get_directory_by_type(source), database)
                async with semaphore:
                    return await fn(request, library)
            except web.HTTPException:
                raise
            except FileNotFoundError:
                return web.json_response({"error": "图片或文件夹已不存在"}, status=404)
            except (ValueError, TypeError, KeyError, UnidentifiedImageError, Image.DecompressionBombError) as error:
                return web.json_response({"error": str(error)}, status=400)
            except (OSError, sqlite3.Error):
                log.exception("Henjicc image library I/O failed")
                return web.json_response({"error": "图片库读写失败，请检查文件权限与宿主日志"}, status=500)
        return handle

    @server.routes.get(PREFIX + "/files")
    @endpoint
    async def files(request, library):
        q = request.query
        offset, rating = int(q.get("offset", 0)), int(q.get("rating", 0))
        if not 0 <= offset <= 1_000_000 or not 0 <= rating <= 5 or len(q.get("q", "")) > 200:
            raise ValueError("查询参数超出范围")
        data = await asyncio.to_thread(library.list, q.get("directory", ""), q.get("q", ""),
                                       q.get("sort", "date"), q.get("order", "desc") == "desc", rating, offset, q.get("kind", "image"))
        return web.json_response(data)

    @server.routes.get(PREFIX + "/thumbnail")
    @endpoint
    async def thumbnail(request, library):
        data = await asyncio.to_thread(library.thumbnail, request.query.get("path", ""))
        return web.Response(body=data, content_type="image/webp", headers={"Cache-Control": "no-cache"})

    @server.routes.get(PREFIX + "/selection")
    @endpoint
    async def selection(request, library):
        relative = request.query.get("path", "")
        if request.query.get("info") == "1":
            return web.json_response(await asyncio.to_thread(library.info, relative))
        await asyncio.to_thread(library.resolve, relative, extensions=resource_extensions(request.query.get("kind", "image")))
        return web.json_response({"path": relative})

    async def body(request):
        if request.content_length is not None and request.content_length > 32768:
            raise web.HTTPRequestEntityTooLarge(max_size=32768, actual_size=request.content_length)
        data = await request.clone(client_max_size=32768).json()
        if not isinstance(data, dict):
            raise ValueError("请求必须是对象")
        return data

    @server.routes.post(PREFIX + "/metadata")
    @endpoint
    async def metadata(request, library):
        data = await body(request)
        await asyncio.to_thread(library.update, data.get("paths"), data.get("rating"), data.get("tags"), data.get("tag_action", "replace"))
        return web.json_response({"ok": True})

    @server.routes.post(PREFIX + "/delete")
    @endpoint
    async def delete(request, library):
        if request.query.get("source", "input") != "input":
            raise web.HTTPForbidden(text="仅输入目录允许删除素材")
        data = await body(request)
        result = await asyncio.to_thread(library.delete, data.get("paths"))
        return web.json_response(result)

    @server.routes.post(PREFIX + "/import")
    @endpoint
    async def import_media(request, library):
        if request.query.get("source", "input") == "input":
            raise ValueError("素材目录类型无效")
        data = await body(request)
        paths = await asyncio.to_thread(library.import_to_input, data.get("paths"), folder_paths.get_input_directory())
        return web.json_response({"paths": paths})
