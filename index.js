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
      console.log('[electron-windows-updater] downloading in process, skip checking')
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
      return download(this.updateData.url, this.downloadPath)
    })
    .then(() => {
      console.log('[electron-windows-updater] unpacking...')
      return mkTempDir()
      .then(dir => {
        console.log('[electron-windows-updater] unpacking to ' + dir)
        this.unpackDir = dir
        return pExtractZip(this.downloadPath, dir)
      })
    })
    .then(() => {
      console.log('[electron-windows-updater] done')
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
 * @param {String} src
 * @param {String} dst
 */
function download(src, dst) {
  return new Promise(function(resolve, reject) {
    let file = fs.createWriteStream(dst)
    let request = https.get(src, function(response) {
      response.pipe(file)
      file.on('finish', function() {
        file.close(resolve)
      })
    })

    request.on('error', function(error) {
      fs.unlink(dst)
      reject(error)
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

module.exports = new Updater()
