#!/bin/bash

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 OUTPUT_DIRECTORY" >&2
  exit 1
fi

DST_DIR=$1

THUMB_DIR=$DST_DIR/thumbs
PHOTO_DIR=$DST_DIR/photos

mkdir $DST_DIR
mkdir $THUMB_DIR $PHOTO_DIR

for f in $(ls | egrep -i ".(jpg|jpeg)" )
do
  filename=$(basename "$f")
  dst_photo="$PHOTO_DIR"/"$filename"
  convert -auto-orient -resize '2000x>' "$f" "$dst_photo"
  convert -resize 150x "$dst_photo" "$THUMB_DIR"/"${filename%.*}".jpg
done
