#!/usr/bin/env bash
set -euo pipefail
helper=$1
probe=$2
root=$(mktemp -d /var/tmp/scient-linux-filesystems-XXXXXX)
cleanup() {
  for folder in "$root"/mount-*; do
    if mountpoint -q "$folder"; then umount "$folder"; fi
  done
  rm -rf "$root"
}
trap cleanup EXIT
for format in ext4 xfs btrfs; do
  truncate -s 512M "$root/$format.img"
  if [ "$format" = ext4 ]; then
    mkfs.ext4 -F "$root/$format.img" >/dev/null 2>&1
  else
    "mkfs.$format" -f "$root/$format.img" >/dev/null 2>&1
  fi
  mkdir "$root/mount-$format"
  mount -o loop "$root/$format.img" "$root/mount-$format"
done
mkdir "$root/mount-tmpfs" "$root/mount-overlay" "$root/lower" "$root/upper" "$root/work"
mount -t tmpfs tmpfs "$root/mount-tmpfs"
mount -t overlay overlay -o "lowerdir=$root/lower,upperdir=$root/upper,workdir=$root/work" "$root/mount-overlay"
python3 - "$helper" "$probe" "$root" <<'PY'
import json, os, subprocess, sys
helper, probe, root = sys.argv[1:]
def call(*args):
    return json.loads(subprocess.check_output([helper, *args], text=True))
def identify(path):
    return call('--linux-folder=1', path, 'directory')
def directory(parent, name):
    stat = os.stat(parent)
    return call('--directory=1', 'private-create', 'linux-held-root', parent, '.', str(stat.st_dev), str(stat.st_ino), str(stat.st_dev), str(stat.st_ino), name)
def command(binding, operation, source, destination):
    ids = [binding[key][field] for key in ('root','parent','record') for field in ('dev','ino')]
    return call('--protocol=1', operation, 'linux-held-root', paper, '.', records, *ids, source, destination)
for format in ('ext4','xfs','btrfs'):
    mount = os.path.join(root, 'mount-' + format)
    result = identify(mount)
    assert result['reason'] is None, result
    identity = result['identity']
    expected = subprocess.check_output(['blkid', '-s', 'UUID', '-o', 'value', os.path.join(root, format + '.img')], text=True).strip().lower()
    assert identity['volume'] == expected, result
    uuid_directory = os.path.join(root, 'uuid-' + format)
    os.mkdir(uuid_directory)
    device = subprocess.check_output(['losetup', '--noheadings', '--output', 'NAME', '-j', os.path.join(root, format + '.img')], text=True).strip()
    assert device.startswith('/dev/loop') and '\n' not in device, device
    os.symlink(device, os.path.join(uuid_directory, expected))
    environment = dict(os.environ, SCIENT_LINUX_UUID_DIRECTORY=uuid_directory)
    fallback = json.loads(subprocess.check_output([probe, '--linux-folder=1', mount, 'directory'], env=environment, text=True))
    assert fallback == result, fallback
    other_uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    if expected == other_uuid: other_uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    os.symlink(device, os.path.join(uuid_directory, other_uuid))
    ambiguous = json.loads(subprocess.check_output([probe, '--linux-folder=1', mount, 'directory'], env=environment, text=True))
    assert ambiguous['identity'] is None and ambiguous['reason'] == 'no-volume-identity', ambiguous
    assert (identity['subvolumeId'] is not None) == (format == 'btrfs'), result
    paper, records = [os.path.join(mount, name) for name in ('paper','records')]
    os.mkdir(paper)
    assert directory(mount, 'records')['code'] == 0
    with open(os.path.join(records, 'slot'), 'w') as file: file.write('complete bytes')
    binding = call('--protocol=1', 'bind', 'linux-held-root', paper, '.', records, *(['-']*8))['binding']
    stage = '.scient-overleaf-apply-' + 'a'*64
    staged = command(binding, 'stage-create', 'slot', stage)
    assert staged['code'] == 0 and staged['flush']['destinationFile'] == 0, staged
    installed = command(binding, 'staged-create', stage, 'new.tex')
    assert installed['code'] == 0 and installed['destinationAfter']['ino'] == staged['destinationAfter']['ino'], installed
    assert installed['sourceAfter'] is None and installed['flush']['destinationDirectory'] == 0, installed
    assert command(binding, 'stage-create', 'slot', stage)['code'] == 0
    occupied = command(binding, 'staged-create', stage, 'new.tex')
    assert occupied['outcome'] == 'unchanged' and occupied['code'] != 0, occupied
    assert open(os.path.join(paper, 'new.tex')).read() == 'complete bytes'
    assert command(binding, 'exchange', 'slot', 'new.tex')['code'] == 0
    subprocess.check_call(['setfacl', '-m', 'd:u:65534:rwx', paper])
    inherited = '.scient-overleaf-apply-' + 'b'*64
    assert command(binding, 'stage-create', 'slot', inherited)['code'] == 0
    assert 'system.posix_acl_access' in os.listxattr(os.path.join(paper, inherited))
    created = directory(paper, 'private')
    assert created['code'] == 0, created
    assert 'system.posix_acl_default' not in os.listxattr(os.path.join(paper, 'private'))
    os.mkdir(os.path.join(paper, 'existing'), 0o700)
    assert directory(paper, 'existing')['code'] != 0
    assert 'system.posix_acl_default' in os.listxattr(os.path.join(paper, 'existing'))
    if format == 'btrfs':
        other = os.path.join(mount, 'other-subvolume')
        subprocess.check_call(['btrfs', 'subvolume', 'create', other], stdout=subprocess.DEVNULL)
        os.chmod(other, 0o700)
        assert identify(other)['identity']['subvolumeId'] != identity['subvolumeId']
        refused = call('--protocol=1', 'bind', 'linux-held-root', paper, '.', other, *(['-']*8))
        assert refused['code'] != 0, refused
    print('PASS Linux ' + format + ': UUID, subvolume, staged create, no-replace, exchange, ACL privacy', flush=True)
for format, reason in [('tmpfs','volatile-filesystem'),('overlay','unsupported-filesystem')]:
    result = identify(os.path.join(root, 'mount-' + format))
    assert result['reason'] == reason and result['identity'] is None, result
    print('PASS Linux ' + format + ' refusal', flush=True)
PY
