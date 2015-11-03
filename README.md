# S3 Album Publisher
A pure client-side photo album publisher for S3.

## Overview
- <b>Browse</b> your bucket for photos.
- <b>Publish</b> albums from your photos.
- <b>Share</b> albums with their public URL.

The albums you publish are <b>private</b>: they can only be found if you
know the album's URL.

Being a pure web-app means:
- <b>Configuration-free:</b> upload the scripts to S3 and start publishing albums right away.
- <b>Database-free:</b> no database is required for creating or viewing albums. Albums are self contained and portable.
- <b>No server-side scripts</b>: all the operations are done in your
  browser, including resizing photos and thumbnails.

## Getting Started

1. Upload `album.html`, `admin.html` and `admin.js` to a path in
your S3 bucket, for example, `public-albums/`. This can be done with
[s3cmd](https://github.com/s3tools/s3cmd):
```bash
s3cmd put album.html admin.html admin.js s3://bucket/public-albums/
```

2. In your browser, navigate to `https://domain.of.bucket/public-albums/admin.html`,
   enter your S3 credentials, and start publishing albums!

## How It Works

##### Publishing
`admin.html` uses the Amazon JavaScript SDK to browse your bucket for
photos you would like to publish in an album. When you create a new
album, a directory in your published albums path is created. For
example, the album with name 'My Holiday Pics' is created in
`public-albums/albums/My Holiday Pics/`. When you add a photo to the
album:
 - it is copied, resized, and placed in `public-albums/albums/My Holiday Pics/photos/`; and
 - a thumbnail is created and placed in `public-albums/albums/My Holiday Pics/thumbs/`.

That's all there is to publishing. No databases. No calls to server-side
scripts. No adding filenames to index files.

##### Viewing
`album.html` is used to view published albums. The name of the album is
specified in the hash of the URL, for example,
`https://domain.of.bucket/public-albums/album.html#My Holiday
Pics`.  The photos for the album are found by listing the contents of
`albums/My Holiday Pics/photos/` (relative to the location of
`album.html`) and then dynamically added to the page.

## S3 Bucket Policy

#### Anonymous access
If you want anyone on the web to view your published albums, your bucket
policy should allow anonymous <i>getObject</i> and <i>listBucket</i>
requests. If your bucket doesn't already allow anonymous requests, the
mimimum you need to add is:

- A statement allowing aonymous <i>getObject</i> requests to the
path of your published albums, for example `public-albums/`:

```js
{
  "Sid": "AnonGetAlbumObjects",
  "Effect": "Allow",
  "Principal": "*",
  "Action": "s3:GetObject",
  "Resource": [
    "arn:aws:s3:::bucket/public-albums/*",
    "arn:aws:s3:::bucket/favicon.ico"
  ]
},
```
- A statement allowing anyone to list the contents of the individual
  album directories (but not list all the albums that you have):
```js
{
  "Sid": "AnonListObjects",
  "Effect": "Allow",
  "Principal": "*",
  "Action": "s3:ListBucket",
  "Resource": "arn:aws:s3:::bucket",
  "Condition": {
    "StringLike": {
      "s3:prefix": "public-albums/albums/*/"
    }
  }
},
```

#### S3 user
The S3 user (also called principal) that you use to publish the albums
should have permission to:
 - read and list the paths where the original photos are stored; and
 - read, list and write the path where the albums are published to,
   again, for example, `public-albums/`.

If your user has all permisions on the whole bucket, then no changes to
the bucket policy are necessary. However, if you want to restrict your
user to the minimum permisions necessary, add the following statements:

- Grant permission to read (but not write) the paths where the original
  photos are stored:

```js
{
  "Sid": "ReadMyPhotosDir",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::1234567890:user/my_albums_user"
  },
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::bucket/my/photo/collection/*"
}
```
- Permission to list the paths where the original photos are stored, as
  well as the published albums:
```js
{
  "Sid": "OnlyListSomeDirs",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::1234567890:user/my_albums_user"
  },
  "Action": "s3:ListBucket",
  "Resource": "arn:aws:s3:::bucket",
  "Condition": {
    "StringLike": {
      "s3:prefix": [
        "my/photo/collection/*",
      "public-albums/*"
      ]
    }
  }
},
```
- Finally, the user should have full control over the directory where
  the published albums are stored:
```js
{
  "Sid": "ObjectActionsOnAlbumsDir",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::1234567890:user/my_albums_user"
  },
  "Action": "s3:*",
  "Resource": [
    "arn:aws:s3:::bucket/public-albums/*",
  "arn:aws:s3:::bucket/public-albums"
  ]
},
```
 
## Custom install

It is also possible to store the albums in your bucket, but keep the
`album.html` on another website. To do this, you can edit the
configuration in `album.html` to point to your S3 bucket. Also, you will
need to ensure the CORS configuration for your bucket allows requests
from different origins:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-amz-meta-custom-header</ExposeHeader>
    <AllowedHeader>*</AllowedHeader>
  </CORSRule>
</CORSConfiguration>
```

## Dependencies

The following dependencies are included in the HTML files and hosted by
CDNs ([cdnjs](https://cdnjs.com/about) and [Goolge Hosted
Libraries](https://developers.google.com/speed/libraries/)):

- Bootstrap
- jQuery
- Fancybox
- Amazon JavaScript SDK

## Optional: External Image Resizer
By default, image resizing is done in the browser. This means that the
original image is downloaded from S3, resized and then uploaded to its
final location. This may perform badly with large photos, slow internet
connections and/or slow web browsers. Furthermore, the resizing in the
browser isn't perfect and may introduce artifacts.

There is a hook in `publish.js` to plugin your own image resizer. You
can, for example, send a XHR request to a PHP script that will download,
resize and upload the photo/thumb to the bucket.

## TODO / Contributing

(Here's where you come in)

- [x] Automatically detect settings (bucket name, paths, etc.)
- [ ] Choose photo and thumb sizes in settings dialog
- [ ] Resize images in the browser without introducing artifacts.
- [ ] Upload images directly from `admin.html`
- [ ] Generate thumbnails for the bucket file browser
- [ ] Select multiple files to add at the same time
- [ ] Filter selectable file types
- [ ] Make the general design more pretty
