#!/usr/bin/env bash
# Mounts throwaway ext4, XFS, Btrfs, tmpfs and overlay filesystems under ROOT for
# LinuxFilePublication.test.ts and hands them to OWNER; `unmount` removes them.
# Needs root. Usage: linux-fixtures.sh mount|unmount ROOT [OWNER]
set -euo pipefail
action=$1
root=$2
case $action in
mount)
  for format in ext4 xfs btrfs; do
    truncate -s 512M "$root/$format.img"
    if [ "$format" = ext4 ]; then mkfs.ext4 -q -F "$root/$format.img"; else "mkfs.$format" -q -f "$root/$format.img" >/dev/null; fi
    mkdir "$root/$format"
    mount -o loop "$root/$format.img" "$root/$format"
  done
  btrfs subvolume create "$root/btrfs/other-subvolume" >/dev/null
  mkdir "$root/tmpfs" "$root/overlay" "$root/lower" "$root/upper" "$root/work"
  mount -t tmpfs tmpfs "$root/tmpfs"
  mount -t overlay overlay -o "lowerdir=$root/lower,upperdir=$root/upper,workdir=$root/work" "$root/overlay"
  chown -R "$3" "$root"
  udevadm settle
  ;;
unmount)
  for folder in overlay tmpfs btrfs xfs ext4; do
    if mountpoint -q "$root/$folder"; then umount "$root/$folder"; fi
  done
  rm -rf "$root"
  ;;
esac
