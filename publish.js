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
        if(cb) return cb(err); return showError(err);
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

  var blob = new Blob(byteArrays, {type: contentType});
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
S3Album.prototype.__publicUrlBase = function () {
  var proto = this.admin.dstBucket.config.sslEnabled ? 'https://' : 'http://';
  if (this.admin.dstBucket.config.s3ForcePathStyle)
    return proto + this.admin.dstBucket.config.endpoint + '/' + this.admin.dstBucket.config.params.Bucket + '/';
  return proto + this.admin.dstBucket.config.params.Bucket + '.' + this.admin.dstBucket.config.endpoint + '/';
};
S3Album.prototype.__photoPublicUrl = function (photoName) {
  return encodeURI(this.__publicUrlBase() + this.__photoPath(photoName));
};
S3Album.prototype.__thumbPublicUrl = function (photoName) {
  return encodeURI(this.__publicUrlBase() + this.__thumbPath(photoName));
};

S3Album.prototype.publicUrl = function (cb) {
  return encodeURI(this.__publicUrlBase() + this.admin.config.dstPrefix + 'view.html')  + '#' + this.albumName + '/';
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

function resizePhotoWithJS(album, hash, cb) {
  function getScale(img, newWidth, newHeight, newScale) {
    var scale = newScale || 1;
    if (newWidth)
      scale = newWidth / img.width;
    else if (newHeight)
      scale = newHeight / img.height;
    if (scale >= 1) scale = 1;   // Don't upscale
    return scale;
  }

  function resizeAndUpload(img, mime, scale, dst, done) {
    var resized = document.createElement('canvas');
    resized.width = img.width * scale;
    resized.height = img.height * scale;
    resized.getContext('2d').drawImage(img, 0, 0, img.width*scale, img.height*scale);

    var dataUrl = resized.toDataURL(mime);
    var resizedBlob = b64toBlob(dataUrl.replace(/^data:\w*\/\w*;base64,/, ''), mime);

    album.admin.dstBucket.putObject({
      Key: dst,
      Body: resizedBlob,
      ContentType: mime
    },
    function (err, data) {
      if (err) { if (done) return done(err); return showError(err); }
      if (done) done(null);
    });
  }

  album.admin.srcBucket.getObject({
    Key: hash.srcImg
  },
  function (err, data) {
    if (err) { if (cb) return cb(err); return showError(err); }

    var blob = new Blob([data.Body], {type: data.ContentType});
    var img = new Image();
    img.src = (window.URL || window.webkitURL).createObjectURL(blob);

    img.onload = function () {
      var photoScale = getScale(img, hash.width, hash.height, hash.scale);
      var thumbScale = getScale(img, hash.thumbWidth, hash.thumbHeight, hash.thumbScale);

      resizeAndUpload(img, data.ContentType, photoScale, hash.dstPhoto, function (err) {
        if (err) { if (cb) return cb(err); return showError(err); }
        resizeAndUpload(img, 'image/jpeg', thumbScale, hash.dstThumb, function (err) {
          if (err) { if (cb) return cb(err); return showError(err); }
          if (cb) cb();
        });
      });
    };
  });
}

// You can plugin a custom photo and thumb resizer here:
var resizePhoto = resizePhotoWithJS;
//var resizePhoto = resizePhotoWithServerScript;

S3Album.prototype.addPhoto = function (path, cb) {
  var self = this;
  var photoName = basename(path);
  var thumbName = stripExt(photoName) + '.jpg';
  var data = {
    srcBucket: self.admin.srcBucket.config.params.Bucket,
    dstBucket: self.admin.dstBucket.config.params.Bucket,
    srcImg: path,
    dstPhoto: self.__photoPath(photoName),
    dstThumb: self.__thumbPath(photoName)
  };
  if (self.photoWidth) data.width = self.photoWidth;
  else if (self.photoHeight) data.height = self.photoHeight;
  else if (self.photoScale) data.scale = self.photoScale;
  if (self.thumbWidth) data.thumbWidth = self.thumbWidth;
  else if (self.thumbHeight) data.thumbHeight = self.thumbHeight;
  else if (self.thumbScale) data.thumbScale = self.thumbScale;

  resizePhoto(self, data, cb);
};

S3Album.prototype.deletePhoto = function (photoName, cb) {
  var self = this;
  self.admin.dstBucket.deleteObjects({
    Delete: {
      Objects: [
        {Key: self.__photoPath(photoName)},
        {Key: self.__thumbPath(photoName)}
      ]}
  },
  function (err, data) {
    if (err) { if(cb) return cb(err); return showError(err); }
    if (cb) cb(null, data);
  });
};


S3Album.prototype.getPhotos = function (cb) {
  var self = this;
  ls(self.admin.dstBucket, self.__photosDir(), function (err, files) {
    if (err) { if(cb) return cb(err); return showError(err); }
    var photos = files.map(function (f) {
      var bn = basename(f);
      return {
        path: f,
        name: bn,
        url: self.__photoPublicUrl(bn),
        thumbUrl: self.__thumbPublicUrl(bn)
      };
    });
    if (cb) cb (err, photos);
  });
};


var S3AlbumAdmin = function (config) {
  var self = this;

  self.config = config || {};
  if (!self.config.defaultThumbHeight &&
      !self.config.defaultThumbWidth && !self.config.defaultThumbScale)
    self.config.defaultThumbHeight = DEFAULT_THUMB_HEIGHT || 150;
  if (!self.config.defaultPhotoHeight &&
      !self.config.defaultPhotoWidth && !self.config.defaultPhotoScale)
    self.config.defaultPhotoWidth = DEFAULT_PHOTO_WIDTH || 1600;

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
    if (err) { if(cb) return cb(err); throw err; }
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
    if (err) { if(cb) return cb(err); return showError(err); }
    if (cb) cb(err, dirs);
  });
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
  var store;
  if (window.localStorage.getItem('settings')) store = window.localStorage;
  else if (window.sessionStorage.getItem('settings')) store = window.sessionStorage;
  else return; // no persisted settings found

  var loaded = JSON.parse(store.getItem('settings'));
  Object.keys(settings).forEach(function (s) {
    settings[s] = loaded[s];
  });
  settings.endpoint = settings.endpoint || 's3.amazonaws.com';
  settings.sslEnabled = settings.sslEnabled === undefined ? true : settings.sslEnabled;
  settings.forcePathStyle = settings.forcePathStyle === undefined ? true : settings.forcePathStyle;
  settings.region = settings.region || 'us-east-1';
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
  init(function (err) {
    if (!err) return $('#settingsModal').modal('hide');
    showError(err);
  });
});

function showError(err, cb) {
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
    s.region = host.split('.').slice(1,2);
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

$('.modal-wide').on('show.bs.modal', function() {
  var height = $(window).height() - 200;
  $(this).find('.modal-body').css('max-height', height);
});

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
      return {Name: d, Type: 'dir', Path: d};
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
 * New album modal
 */
$('#newAlbumModal form').on('submit', function (e) {
   e.preventDefault();
   var name = $('#newAlbumModal form input').val();
   $('#albumList').append('<li><a href="#' + name + '">' + name + '</a></li>');
   location.hash = name;
   $('#newAlbumModal form input').val('');
   $('#newAlbumModal').modal('hide');
});
$('#newAlbumModal').on('shown.bs.modal', function () {
   $('#newAlbumModal form input').focus();
});

/*
 * Albums and navigation
 */
function refreshAlbum() {
  var album = app.controller.album(app.selectedAlbum);
  document.title = app.selectedAlbum + ' | AlbumS3 Admin';
  $('#pageTitle').text(app.selectedAlbum);
  $('#albumPublicUrl').val(album.publicUrl());
  album.getPhotos(function (err, photos) {
    if (err) return showError(err);
    $('#albumThumbs').empty();

    photos.forEach(function (p) {
      $('#albumThumbs').append([
        '<div class="col-lg-3 col-md-4 col-xs-6 thumb">',
          '<div class="thumbnail">',
            '<a class="fancybox" rel="group" title="', p.name, '" href="', p.url, '">',
              '<img class="img-responsive" src="', p.thumbUrl, '" alt="">',
            '</a>',
            '<div class="caption">',
              '<button class="btn btn-default delete-photo" href="javascript:void(0)" data-photo="', p.name, '">',
                '<i class="glyphicon glyphicon-trash"></i>',
              '</button> ',
              p.name,
            '</div>',
          '</div>',
        '</div>'].join(''));
    });
    $(".fancybox").fancybox();
  });
}

$('#albumThumbs').on('click', '.delete-photo', function (e) {
  var photoName = $(this).data('photo');
  app.controller.album(app.selectedAlbum).deletePhoto(photoName, function (err, data) {
    if (err) return showError(err);
    refreshAlbum();
  });
});

function switchToAlbum(name) {
  if (name === '') return;
  $('.main').show();
  $('#albumList li').removeClass('active');
  $('#albumList a').filter(function () { return $(this).text() === name; }).parent().addClass('active');
  app.selectedAlbum = name;
  location.hash = name;
  refreshAlbum();
}

function updateAlbumList(cb) {
  app.controller.getAlbumNames(function (err, albums) {
    if (err) { if(cb) return cb(err); return showError(err); }
    albums.forEach(function (a) {
      $('#albumList').append('<li><a href="#' + a + '">' + a + '</a></li>');
    });
    if (cb) cb(null, albums);
  });
}

$(window).on('hashchange', function () {
  switchToAlbum(location.hash.slice(1));
});

function init(cb) {
  var srcBucket = new AWS.S3({
    signatureVersion: 'v4',
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
    sslEnabled: settings.sslEnabled,
    s3ForcePathStyle: settings.forcePathStyle,
    params: {Bucket: settings.srcBucketName }
  });
  var dstBucket = new AWS.S3({
    signatureVersion: 'v4',
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
    sslEnabled: settings.sslEnabled,
    s3ForcePathStyle: settings.forcePathStyle,
    params: {Bucket: settings.srcBucketName }
  });

  app.controller = new S3AlbumAdmin({
    srcBucket: srcBucket,
    dstBucket: dstBucket,
    srcPrefixes: settings.srcPrefixes.split(','),
    dstPrefix: settings.dstPrefix
  });

  $('#albumList li').empty();
  updateAlbumList(function (err, albums) {
    if (err) { if(cb) return cb(err); return showError(err); }
    var selected = location.hash.slice(1);
    if (albums.indexOf(selected) !== -1)
      switchToAlbum(selected);
    if (cb) cb();
  });
}

$(document).ready(function () {
  loadPersistedSettings();
  if (!settings.accessKeyId) // we need to get some settings
    return $('#settingsModal').modal('show');
  init();
});
