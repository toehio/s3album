#!/bin/bash

S3CFG_FILE=~/.config/s3cfg
BUCKET_NAME=

s3cmd -c $S3CFG_FILE sync $1 s3://$BUCKET_NAME/albums/albums/
