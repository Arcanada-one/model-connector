"""Receive protected Billing3a fixture bytes, never a monetary/runtime grant.

The caller must acquire the private input through its separately qualified CI
route. This receiver does not fetch, stage, authorize, or publish source.
"""
from pathlib import Path
import hashlib
import json
import os
import stat
import errno

REVISION = '3a169ddfd2efd1af6ca160247430ffab41df0c64'
REPOSITORY = 'Arcanada-one/arcanada-workspace'
PINS_SHA256 = '3fa89a10c8f98d86b872912befd3b945fb9d8a11dfc220e42348fe09fe9ff486'


class InputRefused(Exception):
    """Generic refusal, without private source or credential excerpts."""


class CleanupRefused(InputRefused):
    """Sanitized unresolved descriptor cleanup; never retry lost numeric FDs."""
    def __init__(self, facts):
        super().__init__('protected fixture cleanup unknown')
        self.cleanup_facts = facts


def _protected(path):
    if (not isinstance(path, Path) or not path.is_absolute()
            or '..' in path.parts or '\x00' in str(path)):
        raise InputRefused('protected fixture input refused')
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise InputRefused('protected fixture input refused')
        if item != path and (not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022):
            raise InputRefused('protected fixture input refused')
    info = path.lstat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise InputRefused('protected fixture input refused')


def _bytes(path, maximum):
    _protected(path)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise InputRefused('protected fixture input refused')
    # A regular leaf can be swapped after lstat; never block on a FIFO open.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > maximum):
            raise InputRefused('protected fixture input refused')
        body = stream.read(maximum + 1)
    if len(body) > maximum:
        raise InputRefused('protected fixture input refused')
    return body


def _object(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise InputRefused('protected fixture input refused')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (UnicodeError, ValueError, TypeError):
        raise InputRefused('protected fixture input refused') from None



def receive_descriptor_catalogue(root, sealed_input):
    """Adapt INFRA SealedInputLease's exact catalogue, never a path/CI grant.

    The genuine supplier receives/authenticates its channel before this call.
    Its existing revalidate() checks the sealed FD bytes. This portion only
    reconciles those entries with MC's original15 module pins. It cannot return
    BillingFixtureLease or a filesystem manifest and creates no private files.
    """
    try:
        raw = (root / 'test/fixtures/billing-3a-module-pins.json').read_bytes()
        if hashlib.sha256(raw).hexdigest() != PINS_SHA256:
            raise InputRefused('protected descriptor catalogue refused')
        pins = _object(raw)
        if type(pins) is not dict or len(pins) != 15:
            raise InputRefused('protected descriptor catalogue refused')
        expected = {'files': 15, 'runtime_authorized': False,
                    'transport_registered': False, 'filesystem_published': False}
        def observe():
            observation = sealed_input.revalidate()
            if (type(observation) is not dict or observation != expected
                    or type(observation['files']) is not int
                    or any(type(observation[key]) is not bool for key in
                           ('runtime_authorized', 'transport_registered', 'filesystem_published'))):
                raise InputRefused('protected descriptor catalogue refused')
        observe()
        entries = sealed_input.entries
        if type(entries) is not dict or set(entries) != set(pins):
            raise InputRefused('protected descriptor catalogue refused')
        for name, entry in entries.items():
            if (type(entry) is not tuple or len(entry) != 3
                    or type(entry[0]) is not int or entry[0] < 3
                    or entry[1] != pins[name]
                    or type(entry[2]) is not int or not 0 <= entry[2] <= 1000000):
                raise InputRefused('protected descriptor catalogue refused')
        observe()
        return {'schema': 'BillingDescriptorCatalogueReceiving/v1',
                'modules': 15, 'pins_sha256': PINS_SHA256,
                'runtime_authorized': False, 'path_lease_available': False}
    except (AttributeError, OSError, ValueError, TypeError, KeyError):
        raise InputRefused('protected descriptor catalogue refused') from None


def receive(root, acquisition_manifest):
    """Validate source custody only; an input manifest is not acquisition authority."""
    try:
        pins_raw = (root / 'test/fixtures/billing-3a-module-pins.json').read_bytes()
        if hashlib.sha256(pins_raw).hexdigest() != PINS_SHA256:
            raise InputRefused('protected fixture input refused')
        pins = _object(pins_raw)
        supplied = _object(_bytes(acquisition_manifest, 8192))
        if (type(supplied) is not dict or set(supplied) != {
                'schema', 'repository', 'revision', 'source_directory', 'modules', 'scope'}
                or supplied['schema'] != 'BillingFixtureProtectedInput/v1'
                or supplied['repository'] != REPOSITORY
                or supplied['revision'] != REVISION
                or supplied['scope'] != 'offline_fixture_only'
                or supplied['modules'] != pins
                or type(supplied['source_directory']) is not str):
            raise InputRefused('protected fixture input refused')
        source = Path(supplied['source_directory'])
        _protected(source)
        if (not source.is_dir() or set(p.name for p in source.iterdir()) != set(pins)):
            raise InputRefused('protected fixture input refused')
        for name, expected in pins.items():
            if hashlib.sha256(_bytes(source / name, 1000000)).hexdigest() != expected:
                raise InputRefused('protected fixture input refused')
        return source
    except (OSError, KeyError, TypeError, ValueError):
        raise InputRefused('protected fixture input refused') from None


def bind_clean_environment(root, clean_env, acquisition_manifest):
    """Return a copy; no ambient environment, download, or source install."""
    if type(clean_env) is not dict or 'BILLING_CUSTODIAN_SOURCE' in clean_env:
        raise InputRefused('protected fixture input refused')
    source = receive(root, acquisition_manifest)
    return {**clean_env, 'BILLING_CUSTODIAN_SOURCE': str(source)}


class SourceCustody:
    """Retain and revalidate borrowed input; not an immutable execution lease.

    Only descriptors acquired here are released. Producer files are never removed.
    Path-based consumers still require the producer's qualified lifetime authority.
    """
    def __init__(self, root, manifest):
        self.root, self.manifest = root, manifest
        self.entries = []
        self.closed = False
        try:
            self.source = receive(root, manifest)
            paths = [manifest, self.source, *sorted(self.source.iterdir())]
            for path in paths:
                _protected(path)
                before = path.lstat()
                directory = path == self.source
                if not (stat.S_ISDIR(before.st_mode) if directory else stat.S_ISREG(before.st_mode)):
                    raise InputRefused('protected fixture input refused')
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if directory: flags |= os.O_DIRECTORY
                fd = os.open(path, flags)
                self.entries.append((path, fd, self._stamp(os.fstat(fd))))
                if (not directory and before.st_nlink != 1) or self._stamp(before) != self.entries[-1][2]:
                    raise InputRefused('protected fixture input refused')
            self.revalidate()
        except BaseException as error:
            try:
                self.release()
            except CleanupRefused as cleanup:
                category = ('OSError' if isinstance(error, OSError) else
                            'InputRefused' if isinstance(error, InputRefused) else 'BaseException')
                cleanup.acquisition_failure = {'kind': 'acquisition', 'class': category, 'status': 'refused'}
                raise cleanup from None
            if isinstance(error, OSError):
                raise InputRefused('protected fixture input refused') from None
            raise

    @staticmethod
    def _stamp(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def revalidate(self):
        if self.closed:
            raise InputRefused('protected fixture input refused')
        try:
            for path, fd, stamp in self.entries:
                _protected(path)
                if self._stamp(path.lstat()) != stamp or self._stamp(os.fstat(fd)) != stamp:
                    raise InputRefused('protected fixture input refused')
            if receive(self.root, self.manifest) != self.source:
                raise InputRefused('protected fixture input refused')
        except OSError:
            raise InputRefused('protected fixture input refused') from None

    def release(self):
        if self.closed: return
        self.closed = True
        entries, self.entries = self.entries, []
        failures = []
        for _, fd, stamp in reversed(entries):
            try:
                # Lost/reused numbers are not authority to close another FD.
                info = os.fstat(fd)
                # Content/link metadata can change on the same retained inode;
                # it is the dispatch revalidator's concern, not FD reuse.
                if (not isinstance(stamp, tuple) or len(stamp) != 8
                        or (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)) !=
                           (stamp[0], stamp[1], stat.S_IFMT(stamp[2]))):
                    failures.append({'status': 'unknown', 'reason': 'descriptor_identity_changed'})
                    continue
                os.close(fd)
            except OSError as error:
                reason = 'descriptor_missing' if error.errno == errno.EBADF else 'descriptor_close_error'
                failures.append({'status': 'unknown', 'reason': reason})
                # Never retry this number: close can release it even on error.
        if failures:
            raise CleanupRefused(failures) from None
