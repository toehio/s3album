DEFAULT_FORCE_PATH_STYLE = undefined;
DEFAULT_ENDPOINT = undefined;
DEFAULT_REGION = undefined;
DEFAULT_DST_PREFIX = undefined;
DEFAULT_SRC_PREFIXES = undefined;
DEFAULT_BUCKET = undefined;
DEFAULT_SSL_ENABLED = undefined;
DEFAULT_PHOTO_WIDTH = 1600;
DEFAULT_THUMB_HEIGHT = 150;
DEFAULT_FILENAME_FROM_DATE = true;
DEFAULT_REVERSE_ALBUMS = false;
DEFAULT_SAVE_ORIGINAL = true;

var settings = {
  /* DON'T CHANGE ANYTHING HERE, YOU *WILL* BE OVERWRITTEN. */
  persistSettings: undefined,
  accessKeyId: undefined,
  secretAccessKey: undefined,
  srcBucketName: undefined,
  srcPrefixes: undefined,
  dstBucketName: undefined,
  endpoint: undefined,
  sslEnabled: undefined,
  forcePathStyle: undefined,
  dstPrefix: undefined,
  region: undefined
};

var app = {
  cwd: '',
  controller: null, // S3AlbumAdmin object
  selectedAlbum: null
};

/*
 * Helpers
 */
function rmTrailingChar(str, c) {
  if (str.slice(-1)[0] === c) return str.slice(0, -1);
  else return str;
}

function addTrailingChar(str, c) {
  if (str.slice(-1)[0] !== c) return str + c;
  else return str;
}

function stripExt(path) {
  return path.slice(0, path.lastIndexOf('.'));
}

function basename(path) {
  return rmTrailingChar(path, '/').split('/').slice(-1)[0];
}

function getExtension(path) {
  return path.split('.').slice(-1)[0];
}

function ls(bucket, path, cb) {
  var dir = addTrailingChar(path, '/');
  try {
    bucket.listObjects({
      Prefix: dir
    },
      function (err, data) {
        if (err) {
          err.path = path;
          if (cb) return cb(err); return showError(err);
        }
        var dirs = data.CommonPrefixes.map(function (p) { return basename(p.Prefix); });
        var files = data.Contents.filter(function (f) { return f.Size > 0; }).map(function (f) { return f.Key; });
        if (cb) cb(null, files, dirs, data);
      });
  }
  catch (err) {
    return cb(err);
  }
}


// From: http://stackoverflow.com/questions/16245767/creating-a-blob-from-a-base64-string-in-javascript
function b64toBlob(b64Data, contentType, sliceSize) {
  contentType = contentType || '';
  sliceSize = sliceSize || 512;

  var byteCharacters = atob(b64Data);
  var byteArrays = [];

  for (var offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    var slice = byteCharacters.slice(offset, offset + sliceSize);

    var byteNumbers = new Array(slice.length);
    for (var i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }

    var byteArray = new Uint8Array(byteNumbers);

    byteArrays.push(byteArray);
  }

  var blob = new Blob(byteArrays, { type: contentType });
  return blob;
}

/*
 * Controller
 */
var S3Album = function (albumsAdmin, albumName) {
  var self = this;
  self.admin = albumsAdmin;
  self.albumName = albumName;
  self.thumbWidth = self.admin.config.defaultThumbWidth;
  self.thumbHeight = self.admin.config.defaultThumbHeight;
  self.thumbScale = self.admin.config.defaultThumbScale;
  self.photoWidth = self.admin.config.defaultPhotoWidth;
  self.photoHeight = self.admin.config.defaultPhotoHeight;
  self.photoScale = self.admin.config.defaultPhotoScale;
};

S3Album.prototype.__photosDir = function () {
  return this.admin.config.albumsPrefix + this.albumName + '/photos/';
};
S3Album.prototype.__photoPath = function (photoName) {
  return this.admin.config.albumsPrefix + this.albumName + '/photos/' + photoName;
};
S3Album.prototype.__thumbPath = function (photoName) {
  return this.admin.config.albumsPrefix + this.albumName + '/thumbs/' + stripExt(photoName) + '.jpg';
};
S3Album.prototype.__originalPath = function (photoName) {
  return this.admin.config.albumsPrefix + this.albumName + '/original/' + photoName;
};
S3Album.prototype.__photoPublicUrl = function (photoName) {
  return encodeURI(this.admin.__publicUrlBase() + this.__photoPath(photoName));
};
S3Album.prototype.__thumbPublicUrl = function (photoName) {
  return encodeURI(this.admin.__publicUrlBase() + this.__thumbPath(photoName));
};

S3Album.prototype.publicUrl = function (cb) {
  return encodeURI(this.admin.__publicUrlBase() + this.admin.config.dstPrefix + 'view.html') + '#' + this.albumName + '/';
};

RESIZE_SCRIPT_URL = 'https://my.domain.com/scripts/s3ImageResizer.php';
function resizePhotoWithServerScript(albumObj, hash, cb) {
  $.ajax({
    type: 'POST',
    url: RESIZE_SCRIPT_URL,
    data: JSON.stringify(hash),
    dataType: "json",
    contentType: "application/json",
    processData: false,
    success: function () {
      if (cb) cb(null);
    },
    error: function (x, status, err) {
      if (cb) return cb(err);
      return showError(err);
    }
  });
}

function resizePhotoWithJS(album, data, cb) {
  // gets orientation from 
  function getOrientation(fileBlob) {
    return new Promise(resolve => {
      fileBlob.arrayBuffer().then(arrayBuffer => {
        const view = new DataView(arrayBuffer);
        if (view.getUint16(0, false) != 0xFFD8) {
          return resolve(-2);
        }
        const length = view.byteLength;
        let offset = 2;
        while (offset < length) {
          if (view.getUint16(offset + 2, false) <= 8) return resolve(-1);
          const marker = view.getUint16(offset, false);
          offset += 2;
          if (marker == 0xFFE1) {
            if (view.getUint32(offset += 2, false) != 0x45786966) {
              return resolve(-1);
            }

            const little = view.getUint16(offset += 6, false) == 0x4949;
            offset += view.getUint32(offset + 4, little);
            const tags = view.getUint16(offset, little);
            offset += 2;
            for (let i = 0; i < tags; i++) {
              if (view.getUint16(offset + (i * 12), little) == 0x0112) {
                return resolve(view.getUint16(offset + (i * 12) + 8, little));
              }
            }
          }
          else if ((marker & 0xFF00) != 0xFF00) {
            break;
          }
          else {
            offset += view.getUint16(offset, false);
          }
        }
        return resolve(-1);
      });
    });
  }

  function getScale(img, newWidth, newHeight, newScale) {
    var scale = newScale || 1;
    if (newWidth)
      scale = newWidth / img.width;
    else if (newHeight)
      scale = newHeight / img.height;
    if (scale >= 1) scale = 1;   // Don't upscale
    return scale;
  }

  function upload(blob, mime, dst, storage) {
    return new Promise((resolve, reject) =>
      album.admin.dstBucket.putObject({
        Key: dst,
        Body: blob,
        ContentType: mime,
        StorageClass: storage || 'STANDARD'
      }, (err) => err ? reject(error) : resolve())
    );
  }

  function resizeAndUpload(img, srcOrientation, mime, scale, dst, storage) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const width = img.width * scale;
    const height = img.height * scale;

    // set proper canvas dimensions before transform & export
    if (4 < srcOrientation && srcOrientation < 9) {
      canvas.width = height;
      canvas.height = width;
    } else {
      canvas.width = width;
      canvas.height = height;
    }

    // transform context before drawing image
    switch (srcOrientation) {
      case 2: ctx.transform(-1, 0, 0, 1, width, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, width, height); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, height); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, height, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, height, width); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, width); break;
    }

    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL(mime);
    const resizedBlob = b64toBlob(dataUrl.replace(/^data:\w*\/\w*;base64,/, ''), mime);

    return upload(resizedBlob, mime, dst, storage);
  }

  function getEXIFDate(blob) {
    return new Promise(resolve => {
      EXIF.getData(blob, function () {
        const exifDate = EXIF.getTag(this, "DateTimeOriginal");
        if (!exifDate)
          return resolve(null);
        resolve(new Date(exifDate.replace(":", "-").replace(":", "-")));
      });
    });
  }

  function processBlob(blob) {
    let photoScale, thumbScale, orientation, img;

    return new Promise(resolve => {
      img = new Image();
      img.src = (window.URL || window.webkitURL).createObjectURL(blob);
      img.onload = () => {
        photoScale = getScale(img, data.width, data.height, data.scale);
        thumbScale = getScale(img, data.thumbWidth, data.thumbHeight, data.thumbScale);
        resolve();
      };
    }).then(
      () => getOrientation(blob).then(o => orientation = o)
    ).then(() => {

      if (data.fileNameFromDate) {
        return getEXIFDate(blob).then(date => {
          if (!date) return true;

          const filename = date.toISOString().split('.')[0];
          const photoBasename = basename(data.dstPhoto);
          data.dstPhoto = data.dstPhoto.slice(0, -photoBasename.length) + filename + '.' + getExtension(photoBasename);

          const thumbBasename = basename(data.dstThumb);
          data.dstThumb = data.dstThumb.slice(0, -thumbBasename.length) + filename + '.jpg'

          if (data.dstOriginal) {
            const originalBasename = basename(data.dstOriginal);
            data.dstOriginal = data.dstOriginal.slice(0, -originalBasename.length) + filename + '.' + getExtension(originalBasename);
          }
        });
      }

    }).then(() => Promise.all([
      resizeAndUpload(img, orientation, data.ContentType, photoScale, data.dstPhoto, 'ONEZONE_IA'),
      resizeAndUpload(img, orientation, 'image/jpeg', thumbScale, data.dstThumb),

      data.saveOriginal ? upload(blob, data.ContentType, data.dstOriginal, 'ONEZONE_IA') : null
    ]).then(() => { }));
  }

  if (data.srcFile) {
    processBlob(data.srcFile).then(cb).catch(cb);
  } else {
    album.admin.srcBucket.getObject({
      Key: data.srcImg
    }, (err, data) => {
      if (err) { if (cb) return cb(err); return showError(err); }

      var blob = new Blob([data.Body], { type: data.ContentType });
      processBlob(blob).then(cb).catch(cb);
    });
  }
}



// You can plugin a custom photo and thumb resizer here:
var resizePhoto = resizePhotoWithJS;
//var resizePhoto = resizePhotoWithServerScript;

S3Album.prototype.addPhoto = function (path, cb) {
  const photoName = basename(path);
  const thumbName = stripExt(photoName) + '.jpg';
  const data = {
    srcBucket: this.admin.srcBucket.config.params.Bucket,
    dstBucket: this.admin.dstBucket.config.params.Bucket,
    srcImg: path,
    dstPhoto: this.__photoPath(photoName),
    dstThumb: this.__thumbPath(thumbName),
    fileNameFromDate: this.admin.config.fileNameFromDate
  };
  if (this.photoWidth) data.width = this.photoWidth;
  else if (this.photoHeight) data.height = this.photoHeight;
  else if (this.photoScale) data.scale = this.photoScale;
  if (this.thumbWidth) data.thumbWidth = this.thumbWidth;
  else if (this.thumbHeight) data.thumbHeight = this.thumbHeight;
  else if (this.thumbScale) data.thumbScale = this.thumbScale;

  resizePhoto(this, data, cb);
};

S3Album.prototype.deletePhoto = function (photoName, cb) {
  var self = this;
  self.admin.dstBucket.deleteObjects({
    Delete: {
      Objects: [
        { Key: self.__photoPath(photoName) },
        { Key: self.__thumbPath(photoName) },
        { Key: self.__originalPath(photoName) }
      ]
    }
  },
    function (err, data) {
      if (err) { if (cb) return cb(err); return showError(err); }
      if (cb) cb(null, data);
    });
};


S3Album.prototype.getPhotos = function (cb) {
  var self = this;
  ls(self.admin.dstBucket, self.__photosDir(), function (err, files) {
    if (err) { if (cb) return cb(err); return showError(err); }
    var photos = files.map(function (f) {
      var bn = basename(f);
      return {
        path: f,
        name: bn,
        url: self.__photoPublicUrl(bn),
        thumbUrl: self.__thumbPublicUrl(bn)
      };
    });
    if (cb) cb(err, photos);
  });
};

S3Album.prototype.uploadNew = function (file, cb) {
  const data = {
    ContentType: file.type,
    srcFile: file,
    dstBucket: this.admin.dstBucket.config.params.Bucket,
    dstPhoto: this.__photoPath(file.name),
    dstThumb: this.__thumbPath(file.name),
    dstOriginal: this.__originalPath(file.name),
    fileNameFromDate: this.admin.config.fileNameFromDate,
    saveOriginal: this.admin.config.saveOriginal,
  };
  if (this.photoWidth) data.width = this.photoWidth;
  else if (this.photoHeight) data.height = this.photoHeight;
  else if (this.photoScale) data.scale = this.photoScale;
  if (this.thumbWidth) data.thumbWidth = this.thumbWidth;
  else if (this.thumbHeight) data.thumbHeight = this.thumbHeight;
  else if (this.thumbScale) data.thumbScale = this.thumbScale;

  resizePhoto(this, data, cb);
}


/* S3AlbumAdmin */

var S3AlbumAdmin = function (config) {
  var self = this;

  self.config = config || {};
  if (!self.config.defaultThumbHeight &&
    !self.config.defaultThumbWidth && !self.config.defaultThumbScale)
    self.config.defaultThumbHeight = DEFAULT_THUMB_HEIGHT || 150;
  if (!self.config.defaultPhotoHeight &&
    !self.config.defaultPhotoWidth && !self.config.defaultPhotoScale)
    self.config.defaultPhotoWidth = DEFAULT_PHOTO_WIDTH || 1600;

  if (!self.config.fileNameFromDate)
    self.config.fileNameFromDate = DEFAULT_FILENAME_FROM_DATE;
  if (!self.config.saveOriginal)
    self.config.saveOriginal = DEFAULT_SAVE_ORIGINAL;

  self.srcBucket = self.config.srcBucket || self.config.bucket;
  self.dstBucket = self.config.dstBucket || self.config.bucket;

  self.config.S3Delimiter = self.config.S3Delimiter || '/';
  self.srcBucket.config.params.Delimiter = self.srcBucket.config.params.Delimiter || self.config.S3Delimiter;
  self.dstBucket.config.params.Delimiter = self.dstBucket.config.params.Delimiter || self.config.S3Delimiter;

  self.config.srcPrefixes = self.config.srcPrefixes || [];
  self.config.dstPrefix = self.config.dstPrefix || 'gallery/';
  self.config.dstPrefix = addTrailingChar(self.config.dstPrefix, '/');

  self.config.albumsPrefix = self.config.albumsPrefix || self.config.dstPrefix + 'albums/';

  self.albums = {};
};

S3AlbumAdmin.prototype.album = function (albumName) {
  var self = this;
  if (!self.albums[albumName])
    self.albums[albumName] = new S3Album(self, albumName);
  return self.albums[albumName];
};

S3AlbumAdmin.prototype.lsSrc = function (path, cb) {
  var self = this;
  ls(self.srcBucket, path, function (err, x, y, data) {
    if (err) { if (cb) return cb(err); throw err; }
    var files = data.Contents.filter(function (f) { return f.Size > 0; })
      .map(function (f) {
        f.Size = f.Size;
        f.Name = basename(f.Key);
        f.Path = f.Key;
        f.Type = 'file';
        return f;
      });
    var dirs = data.CommonPrefixes.map(function (d) {
      d.Name = basename(d.Prefix);
      d.Path = d.Prefix;
      d.Type = 'dir';
      return d;
    });

    if (cb) cb(null, files.concat(dirs));
  });
};

S3AlbumAdmin.prototype.getAlbumNames = function (cb) {
  var self = this;
  ls(self.dstBucket, self.config.albumsPrefix, function (err, files, dirs) {
    if (err) { if (cb) return cb(err); return showError(err); }
    if (cb) cb(err, dirs);
  });
};

S3AlbumAdmin.prototype.__publicUrlBase = function () {
  var proto = this.dstBucket.config.sslEnabled ? 'https://' : 'http://';
  if (this.dstBucket.config.s3ForcePathStyle)
    return proto + this.dstBucket.config.endpoint + '/' + this.dstBucket.config.params.Bucket + '/';
  return proto + this.dstBucket.config.params.Bucket + '.' + this.dstBucket.config.endpoint + '/';
};

S3AlbumAdmin.prototype.publicUrl = function (cb) {
  return encodeURI(this.__publicUrlBase() + this.config.dstPrefix + 'gallery.html');
};

// init

function init() {
  var srcBucket = new AWS.S3({
    signatureVersion: 'v4',
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
    sslEnabled: settings.sslEnabled,
    s3ForcePathStyle: settings.forcePathStyle,
    params: { Bucket: settings.srcBucketName }
  });
  var dstBucket = new AWS.S3({
    signatureVersion: 'v4',
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
    sslEnabled: settings.sslEnabled,
    s3ForcePathStyle: settings.forcePathStyle,
    params: { Bucket: settings.srcBucketName }
  });

  app.controller = new S3AlbumAdmin({
    srcBucket: srcBucket,
    dstBucket: dstBucket,
    srcPrefixes: settings.srcPrefixes.split(','),
    dstPrefix: settings.dstPrefix
  });
}

/**
 * Uploading
 */

let uploadQueue = [];

function uploadNext() {
  if (uploadQueue.length > 0) {

    const album = app.controller.album(app.selectedAlbum);
    album.uploadNew(uploadQueue[0], (err) => {
      if (err) return;

      uploadQueue.shift();
      uploadNext();

      refreshUploadQueue();
      refreshAlbum()
    });
  }
}

function pushToUploadQueue(files) {
  uploadQueue.push(...files);
  refreshUploadQueue();

  if (uploadQueue.length == files.length)
    uploadNext();
}

function refreshUploadQueue() {
  $('#uploadQueue').empty();

  if (uploadQueue.length > 0) {
    $('#uploadQueue').append(`<span>Uploading ${uploadQueue[0].name}. In queue: ${uploadQueue.length - 1}</span>`);
  }
}

/*
 * Bucket browser modal
 */
$('#fileBrowserModal').on('show.bs.modal', updateFileBrowser);
$('#fileBrowserModal').on('hide.bs.modal', refreshAlbum);

function updateFileBrowser() {

  // Breadcrumbs
  $('#filesBreadcrumbs').html('<li><a href="javascript:void(0)" data-path="" class="btn btn-default"><i class="glyphicon glyphicon-home"></i></a></li>');
  var path = '';
  var crumbs = app.cwd.split('/').filter(function (s) { return s !== ''; });
  crumbs.forEach(function (d, i) {
    path += d + '/';
    if (i === crumbs.length - 1) return $('#filesBreadcrumbs').append('<li>' + d + '</li>');
    $('#filesBreadcrumbs').append('<li><a href="javascript:void(0)" data-path="' + path + '">' + d + '</a></li>');
  });
  $('#filesBreadcrumbs a').on('click', function () {
    cd($(this).data('path'));
  });

  // Files table
  $('#filesTable').bootstrapTable('load', []); // clear the table
  if (app.cwd === '') {
    app.cwd = '';
    var initialDirs = app.controller.config.srcPrefixes.map(function (d) {
      return { Name: d, Type: 'dir', Path: d };
    });
    $('#filesTable').bootstrapTable('append', initialDirs);
    return;
  }
  app.controller.lsSrc(app.cwd, function (err, files) {
    if (err) return showError(err);
    $('#filesTable').bootstrapTable('append', files);
  });
}

function cd(path) {
  app.cwd = rmTrailingChar(path, '/');
  updateFileBrowser();
}

$('#filesTable').on('click-row.bs.table', function (e, row, $element) {
  if (row.Type === 'file') return;
  cd(row.Path);
});

window.actionColumnFormatter = function (value, file, index) {
  if (!file || file.Type !== 'file') return;
  return [
    '<a class="add_to_gallery" href="javascript:void(0)" title="Add to gallery">',
    '<i class="glyphicon glyphicon-plus"></i>',
    '</a>',
  ].join('');
};

window.nameColumnFormatter = function (value, file, index) {
  if (!value) return;
  var pic;
  if (file.Type === 'dir') pic = '<i class="glyphicon glyphicon-folder-open"></i>';
  else {
    var ext = getExtension(value);
    switch (ext.toLowerCase()) {
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'png':
        pic = '<i class="glyphicon glyphicon-picture"></i>';
        break;
      default:
        pic = '<i class="glyphicon glyphicon-file"></i>';
    }
  }
  pic += '&nbsp;&nbsp;';
  if (file.Type === 'file') return pic + value;
  return '<a href="javascript:void(0)">' + pic + value + '</a>';
};

window.actionColumnEvent = {
  'click .add_to_gallery': function (e, value, row, index) {
    app.controller.album(app.selectedAlbum).addPhoto(row.Key);
  }
};

window.filesSorter = function (a, b) {
  // TODO: sort the table
};

/*
 * Settings modal
 */

function clearPersistedSettings() {
  window.localStorage.removeItem('settings', undefined);
  window.sessionStorage.removeItem('settings', undefined);
}

function dumpPersistedSettings() {
  clearPersistedSettings();
  var store;
  if (settings.persistSettings === 'local') store = window.localStorage;
  else if (settings.persistSettings === 'session') store = window.sessionStorage;
  else return; // we are not supposed to persist settings

  store.setItem('settings', JSON.stringify(settings));
}

function loadPersistedSettings() {
  let loaded;

  // if there are settings in url, load them instead
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('settings')) {

    loaded = JSON.parse(urlParams.get('settings'));

    console.log(loaded);

    urlParams.delete('settings');

    // also remove them from history
    window.location.replace(window.location.toString().replace(/\?.*/, '?' + urlParams.toString()));

  } else {

    let store;
    if (window.localStorage.getItem('settings')) store = window.localStorage;
    else if (window.sessionStorage.getItem('settings')) store = window.sessionStorage;

    if (store)
      loaded = JSON.parse(store.getItem('settings'));
  }

  if (loaded) {
    Object.keys(settings).forEach(function (s) {
      settings[s] = loaded[s];
    });
    settings.endpoint = settings.endpoint || 's3.amazonaws.com';
    settings.sslEnabled = settings.sslEnabled === undefined ? true : settings.sslEnabled;
    settings.forcePathStyle = settings.forcePathStyle === undefined ? true : settings.forcePathStyle;
    settings.region = settings.region || 'us-east-1';

    dumpPersistedSettings();
  }
}

$('#settingsModal form').on('submit', function (e) {
  e.preventDefault();
  Object.keys(settings).forEach(function (s) {
    var $input = $('#settingsModal input[name="' + s + '"]');
    var v = $input.val();
    if ($input.attr('type') === 'checkbox') v = $input.prop('checked');
    if ($input.attr('type') === 'radio') v = $input.filter(':checked').val();
    if (v !== undefined) settings[s] = v;
  });
  settings.endpoint = settings.endpoint === '' ? 's3.amazonaws.com' : settings.endpoint;
  settings.region = settings.region === '' ? 'us-east-1' : settings.region;
  dumpPersistedSettings();
  init();
  $('#settingsModal').modal('hide');
});

function showError(err, cb) {
  console.error(err);
  if (!err) return;
  var msg = err;
  if (err.url) msg += '<br><br>Trying to access: ' + err.url;
  $('#errorModal .modal-body div').html(msg);
  $('#errorModal').modal('show');
  if (cb) $('#errorModal').one('hide.bs.modal', cb);

}

function detectSettings() {
  var s = {};
  var host = window.location.hostname;
  var path = window.location.pathname.split('/').slice(1);
  var names, me;
  s.forcePathStyle = true;
  if (host.endsWith('s3.amazonaws.com') &&
    (names = host.split('.')).length === 4) {
    s.dstBucketName = names[0];
    s.endpoint = names.slice(1).join('.');
    s.forcePathStyle = false;
    me = path;
  }
  else {
    s.dstBucketName = path[0];
    me = path.slice(1);
    s.endpoint = host;
  }

  if (host.startsWith('s3.') &&
    host.endsWith('.amazonaws.com') &&
    (names = host.split('.')).length === 4) {
    s.region = host.split('.').slice(1, 2);
  }

  if (me.join('').endsWith('.html'))
    s.dstPrefix = me.slice(0, -1).join('/');
  else
    s.dstPrefix = me.join('/');

  s.sslEnabled = DEFAULT_SSL_ENABLED || window.location.protocol.startsWith('https');
  s.dstBucketName = DEFAULT_BUCKET || s.dstBucketName;
  s.srcBucketName = DEFAULT_BUCKET || s.dstBucketName;
  s.dstPrefix = DEFAULT_DST_PREFIX || s.dstPrefix;
  s.srcPrefixes = DEFAULT_SRC_PREFIXES; // TODO: How can we guess this?
  s.endpoint = DEFAULT_ENDPOINT || s.endpoint;
  s.region = DEFAULT_REGION || s.region;
  s.forcePathStyle = DEFAULT_FORCE_PATH_STYLE || s.forcePathStyle;
  return s;
}

$('#settingsModal').on('show.bs.modal', function (e) {
  var detected = detectSettings();
  Object.keys(settings).forEach(function (s) {
    var $input = $('#settingsModal input[name="' + s + '"]');

    if (settings[s] === undefined && detected[s] !== undefined) {
      settings[s] = detected[s];
      $input.parent().find('.detected-config').show();
      $input.parent().parent().addClass('has-success');
    }

    if ($input.attr('type') === 'radio')
      return $input.filter('[value="' + settings[s] + '"]').prop('checked', true);
    if ($input.attr('type') === 'checkbox')
      return $input.prop('checked', settings[s]);
    $input.val(settings[s]);
  });
});

$('#clearPersistedSettings').on('click', function () {
  clearPersistedSettings();
  alert('All persisted settings cleared!');
});

$('#settingsModal input').on('change', function (e) {
  if ($(this).parent().parent().hasClass('has-success')) {
    $(this).parent().find('.detected-config').hide();
    $(this).parent().parent().removeClass('has-success');
  }
});

$('#srcBucketName').on('change keyup', function () {
  if ($('#useSameBucket').prop('checked'))
    $('#dstBucketName').val($(this).val());
});
$('#useSameBucket').on('change', function () {
  $('#dstBucketName').prop('disabled', $(this).prop('checked'));
  if ($(this).prop('checked')) $('#dstBucketName').val($('#srcBucketName').val());
});
$('#dstBucketName').on('change', function () {
  if ($('#dstBucketName').val() === $('#srcBucketName').val()) {
    $('#useSameBucket').prop('checked', true);
    $('#dstBucketName').prop('disabled', true);
  }
});

$('.modal-wide').on('show.bs.modal', function () {
  var height = $(window).height() - 200;
  $(this).find('.modal-body').css('max-height', height);
});

/** 
 * Album
 */

function setNewAlbumTitle() {
  const title = $('#albumTitle').val();

  if (title) {
    app.selectedAlbum = title;

    refreshAlbum();
  }
}

function refreshAlbum() {
  var album = app.controller.album(app.selectedAlbum);

  document.title = app.selectedAlbum || 'Upload new album';
  $('#albumThumbs').empty();

  if (app.selectedAlbum) {
    $('#albumTitle').attr("readonly", "");
    $('#setAlbumTitle').hide();
    $('#uploadZone').show();
    $('#openAlbum').attr("href", album.publicUrl());

    album.getPhotos(function (err, photos) {
      if (err) return showError(err);

      photos.forEach(function (p) {
        $('#albumThumbs').append([
          '<div class="col-lg-3 col-md-4 col-xs-6">',
          '<a class="thumbnail fancybox" rel="group" title="', p.name, '" href="', p.url, '">',
          '<img src="', p.thumbUrl, '" alt="">',
          '<div class="caption">',
          '<button class="btn btn-default delete-photo" href="javascript:void(0)" data-photo="', p.name, '">',
          '<i class="glyphicon glyphicon-trash"></i>',
          '</button> ',
          p.name,
          '</div>',
          '</a>',
          '</div>'].join(''));
      });
      $(".fancybox").fancybox();
    });
  } else {
    $('#albumTitle').removeAttr("readonly");
    $('#setAlbumTitle').show();
    $('#uploadZone').hide();
  }
}

$('#albumThumbs').on('click', '.delete-photo', function (e) {
  var photoName = $(this).data('photo');
  app.controller.album(app.selectedAlbum).deletePhoto(photoName, function (err, data) {
    if (err) return showError(err);
    refreshAlbum();
  });
  return false;
});

/**
 * General
 */

function updateAlbumList(cb) {
  app.controller.getAlbumNames(function (err, albums) {
    if (err) { if (cb) return cb(err); return showError(err); }

    if (DEFAULT_REVERSE_ALBUMS) albums = albums.reverse();

    albums.forEach(function (a) {
      $('#albumList').append('<li><a href="#' + a + '">' + a + '</a></li>');
    });
    if (cb) cb(null, albums);
  });
}

function hashChanged() {
  app.selectedAlbum = decodeURIComponent(location.hash.slice(1));
  $('#albumTitle').val(app.selectedAlbum);
  refreshAlbum();
}

$(window).on('hashchange', hashChanged);

$(document).ready(function () {
  loadPersistedSettings();

  init();

  $('#inputFile').change((a) => {
    pushToUploadQueue(a.target.files);
  });
  $('#openPublicGallery').attr("href", app.controller.publicUrl());

  updateAlbumList();

  hashChanged();
});
