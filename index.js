'use strict'

const app = require('electron').app
const temp = require('temp')
const os = require('os')
const fs = require('fs')
const path = require('path')
const EventEmitter = require('events').EventEmitter
const http = require('http')
const https = require('https')
const parseUrl = require('url').parse
const child_process = require('child_process')
const extractZip = require('extract-zip')

const GetSystem32Path = require('get-system32-path').GetSystem32Path
const CSCRIPT = GetSystem32Path() + '\\cscript.exe'

class Updater extends EventEmitter {
  constructor() {
    super()
    this.feedURL = null
    this.downloadPath = null
    this.downloading = false
    this.updateData = null
    this.unpackDir = null
    this.allowHttp = false
  }

  /**
   * @param {String} url
   */
  setFeedURL(url) {
    this.feedURL = url
  }

  quitAndInstall() {
    let script = path.join(__dirname, 'run-elevated.vbs')
    let bat = path.join(__dirname, 'copy-elevated.bat')
    let exe = process.execPath
    let src = this.unpackDir
    let dst = path.dirname(process.execPath)

    let args = [script, bat, exe, src, dst, GetSystem32Path()]

    child_process.spawn(CSCRIPT, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref()

    app.quit()
  }

  checkForUpdates() {
    if (this.downloading) {
      _log('downloading in process, skip checking')
      return
    }

    if (!this.feedURL) {
      throw new Error('feedURL is not specified')
    }

    request(this.feedURL)
    .then(response => {
      if (response.statusCode != 200 && response.statusCode != 204) throw new Error('invalid status code: ' + response.statusCode)
      if (response.statusCode == 204) {
        this.emit('update-not-available')
        return
      }

      let data = JSON.parse(response.body)
      if (!this.allowHttp && parseUrl(data.url).protocol != 'https:') {
        throw new Error('update url must be https')
      }

      this.updateData = data
      this.emit('update-available')
    })
    .then(() => {
      // Download
      this.downloadPath = temp.path({ suffix: '.zip' })
      this.downloading = true
      _log('downloading ' + this.updateData.url + ' to ' + this.downloadPath)
      return this._download(this.updateData.url, this.downloadPath)
    })
    .then(() => {
      return mkTempDir()
      .then(dir => {
        _log('unpacking to ' + dir)
        this.unpackDir = dir
        return pExtractZip(this.downloadPath, dir)
      })
    })
    .then(() => {
      _log('an update has been successfully downloaded and unpacked')
      this.emit('update-downloaded', this.updateData)
    })
    .catch(e => {
      this.downloadPath = null
      this.updateData = null
      this.unpackDir = null
      this.downloading = false
      console.error('[electron-windows-updater]', e)
      this.emit('error', e)
    })
  }

  /**
   * @param {String} src
   * @param {String} dst
   * @return {Promise}
   */
  _download(src, dst) {
    const PROGRESS_PERIOD = 500
    return new Promise((resolve, reject) => {
      let module = parseUrl(src).protocol == 'https:' ? https : http
      let request = module.get(src, response => {
        if (response.statusCode != 200) {
          reject(new Error("HTTP status code is " + response.statusCode))
          return
        }

        let file = fs.createWriteStream(dst)
        let downloaded = 0
        let progressTs = 0

        response.pipe(file)

        file.on('finish', () => {
          this.emit('download-progress', 100)
          response.unpipe()
          resolve()
        })

        response.on('data', buf => {
          downloaded += buf.length
          let now = Date.now()
          if (now - progressTs > PROGRESS_PERIOD) {
            progressTs = now
            this.emit('download-progress', downloaded / this.updateData.size * 100)
          }
        })
      })

      request.on('error', function(error) {
        fs.unlink(dst)
        reject(error)
      })
    })
  }
}

/**
 * @return {Promise}
 */
function pExtractZip(src, dst) {
  return new Promise(function(resolve, reject) {
    let noAsar = process.noAsar
    process.noAsar = true
    extractZip(src, { dir: dst }, function (err) {
      process.noAsar = noAsar
      !err ? resolve() : reject(err)
    })
  })
}


/**
 * @param {String} cmd
 * @param {Array} args
 * @param {Object} opts
 * @return {Promise}
 */
function execute(cmd, args, opts) {
  return new Promise(function(resolve, reject) {
    let child = child_process.spawn(cmd, args, opts)
    let stderr = [], stdout = []
    child.stderr.on('data', function(data) {
      stderr.push(data)
    })
    child.stdout.on('data', function(data) {
      stdout.push(data)
    })
    child.on('exit', function(code) {
      if (code != 0) {
        reject('"' + cmd + '" returned ' + code +
               "\nstdout: " + Buffer.concat(stdout).toString('utf-8') +
               "\nstderr: " + Buffer.concat(stderr).toString('utf-8')
              )
      } else {
        resolve()
      }
    })
  })
}

/**
 * @return {Promise}
 */
function mkTempDir() {
  return new Promise(function(resolve, reject) {
    temp.mkdir(null, function(e, path) {
      e ? reject(e) : resolve(path)
    })
  })
}


/**
 * @param {String} url
 * @return {Promise}
 */
function request(url) {
  return new Promise(function(resolve, reject) {
    let p = parseUrl(url)
    let module = ( p.protocol == 'https:' ? https : http )

    let req = module.request({
      method: 'GET',
      host: p.host,
      path: p.path
    })

    req.on('response', function(res) {
      let chunks = []
      res.on('data', function(chunk) {
        chunks.push(chunk)
      })
      res.on('end', function() {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf-8')
        })
        chunks = undefined
      })
    })
    req.end()
    req.on('error', function(error) {
      reject(error)
    })
  })
}

function _log(...args) {
  args.unshift('<electron-windows-updater>')
  console.log.apply(console, args)
}

module.exports = new Updater()
