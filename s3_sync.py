#!/usr/bin/env python3
"""
Standalone script: copy files between this machine and an S3 bucket.

Usage:
  python3 s3_sync.py 1           upload every file under LOCAL_DIR to the bucket
  python3 s3_sync.py 2           download every object in the bucket to LOCAL_DIR
  python3 s3_sync.py <TICKET>    list and download objects under TICKET_PREFIX/CCTN<ticket>
                                 e.g. CCTN202610210001 or just 202610210001

Object keys are file paths relative to LOCAL_DIR, e.g.
  <LOCAL_DIR>/SRE/Incident/CCTN202610210001/log.txt  <->  SRE/Incident/CCTN202610210001/log.txt

Edit the CONFIG section below before running. Needs boto3:  pip3 install boto3
"""
import os
import sys

# ============================== CONFIG ==============================
S3_ENDPOINT = ""                  # bucket service URL, e.g. "https://s3.internal.example.com"; "" for AWS
S3_BUCKET = ""                    # bucket name (required)
S3_REGION = "ap-southeast-1"
S3_ACCESS_KEY = ""                # access key (required)
S3_SECRET_KEY = ""                # secret key (required) - keep this file private
S3_VERIFY_SSL = True              # False for an internal endpoint with a private certificate

LOCAL_DIR = "/Users/jahabarsadik/source_code/nodejs/incident-portal/Attachment"  # upload from here (1)
DOWNLOAD_DIR = LOCAL_DIR          # download to here (2 and ticket pulls)
TICKET_PREFIX = "SRE/Incident/"   # folder in the bucket that holds CCTN<ticket> folders
# ====================================================================

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:
    sys.exit("boto3 is not installed. Run: pip3 install boto3")


def connect():
    """Return an S3 client built from the CONFIG section."""
    missing = [n for n in ("S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY") if not globals()[n]]
    if missing:
        sys.exit(f"Set {', '.join(missing)} in the CONFIG section of {os.path.basename(__file__)}.")
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT or None,
        region_name=S3_REGION or None,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        verify=S3_VERIFY_SSL,
        # path-style URLs so any S3-compatible store works
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
    )


def list_objects(client, prefix=""):
    """All objects under prefix as [{Key, Size, LastModified}], following pagination."""
    objects = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=S3_BUCKET, Prefix=prefix):
        objects.extend(o for o in page.get("Contents", []) if not o["Key"].endswith("/"))
    return objects


def upload_all(client, local_dir):
    if not os.path.isdir(local_dir):
        sys.exit(f"Folder not found: {local_dir}")
    count = 0
    for root, _dirs, files in os.walk(local_dir):
        for name in files:
            path = os.path.join(root, name)
            key = os.path.relpath(path, local_dir).replace(os.sep, "/")
            print(f"upload   {path} -> s3://{S3_BUCKET}/{key}")
            client.upload_file(path, S3_BUCKET, key)
            count += 1
    print(f"Uploaded {count} file(s).")


def download(client, objects, local_dir):
    """Save each object to local_dir/<key>. Keys that would escape local_dir are skipped."""
    base = os.path.realpath(local_dir)
    count = 0
    for obj in objects:
        key = obj["Key"]
        path = os.path.realpath(os.path.join(base, *key.split("/")))
        if not path.startswith(base + os.sep):
            print(f"skip     {key} (unsafe path)")
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print(f"download s3://{S3_BUCKET}/{key} -> {path}")
        client.download_file(S3_BUCKET, key, path)
        count += 1
    print(f"Downloaded {count} file(s).")


def pull_ticket(client, ticket, local_dir):
    ticket = ticket.strip().strip("/")
    if not ticket.upper().startswith("CCTN"):
        ticket = "CCTN" + ticket
    prefix = f"{TICKET_PREFIX.strip('/')}/{ticket}"
    objects = list_objects(client, prefix)
    if not objects:
        print(f"No objects found under s3://{S3_BUCKET}/{prefix}")
        return
    print(f"Objects under s3://{S3_BUCKET}/{prefix}:")
    for o in objects:
        print(f"  {o['Key']}  {o['Size']} bytes  {o['LastModified']:%Y-%m-%d %H:%M:%S}")
    download(client, objects, local_dir)


def main():
    if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0 if len(sys.argv) == 2 else 1)

    action = sys.argv[1]
    client = connect()
    try:
        if action == "1":
            upload_all(client, LOCAL_DIR)
        elif action == "2":
            download(client, list_objects(client), DOWNLOAD_DIR)
        else:
            pull_ticket(client, action, DOWNLOAD_DIR)
    except (BotoCoreError, ClientError) as err:
        sys.exit(f"S3 error: {err}")


if __name__ == "__main__":
    main()
