'use strict'

const app = require('electron').app
const temp = require('temp')
const os = require('os')
const fs = require('fs-extra')
const path = require('path')
const EventEmitter = require('events').EventEmitter
const http = require('http')
const https = require('https')
const parseUrl = require('url').parse
const child_process = require('child_process')
const extractZip = require('extract-zip')
const util = require('util')

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
    this.exeName = null
  }

  /**
   * @param {String} url
   */
  setFeedURL(url) {
    this.feedURL = url
  }

  /**
   * @param {String} name
   */
  setExecutableName(name) {
    this.exeName = name
  }

  quitAndInstall() {
    let script = path.join(__dirname, 'run-elevated.vbs')

    let args = [
      script,
      path.join(this.unpackDir, this.exeName), // new exe path

      path.dirname(process.execPath), // destination dir
      this.exeName // executable to run after install
    ]

    fileLog.write('quitAndInstall(); running ' + CSCRIPT + ' ' + args.join(' '))

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
    .then(() => punlink(this.downloadPath, true))
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

const INSTALLER_TASK_ARGS_COUNT = {
  install: 2,
  'post-install': 2
}
const INSTALLER_PREFIX = '--ewu-'

class Installer extends EventEmitter {
  constructor() {
    super()
    this.copyFailed = false
  }

  process() {
    let task = null, taskArgs = []
    for (let i = 1; i < process.argv.length; i++) {
      let a = process.argv[i]
      if (!a.startsWith(INSTALLER_PREFIX)) continue

      task = a.substr(INSTALLER_PREFIX.length)
      if (INSTALLER_TASK_ARGS_COUNT[task] === undefined) continue

      let argsCount = INSTALLER_TASK_ARGS_COUNT[task]
      if (argsCount) {
        taskArgs = process.argv.slice(i+1, i+1+argsCount)
      }
      break
    }

    if (task === null) {
      return false
    }

    fileLog.write('Installer.process() argv:', process.argv.join(' '))

    switch (task) {
      case 'install': {
        let [ dst, exeName ] = taskArgs
        let src = path.dirname(process.execPath)

        this._install(src, dst, exeName)
        return true
      }

      case 'post-install': {
        this._postInstall(taskArgs[0])
        if (parseInt(taskArgs[1]) == 0) {
          this.copyFailed = true
        }
        break
      }
    }
  }

  _install(src, dst, exeName) {
    fileLog.write('Installer._install()', src, dst)

    let copyOk = true

    this._copy(src, dst)
    .then(result => {
      copyOk = result
    })
    .then(() => this._clearIconCache())
    .then(() => this._launchApp(path.join(dst, exeName), src, copyOk))
  }

  _copy(src, dst) {
    process.noAsar = true
    return new Promise(function(resolve, reject) {
      fs.copy(src, dst, function(err) {
        if (err) {
          fileLog.write('Installer._copy("' + src + '", "' + dst + '") failed:', err)
          resolve(false)
        } else {
          resolve(true)
        }
      })
    })
  }

  _clearIconCache() {
    const sysRoot = GetSystem32Path()
    return pexecute(path.join(sysRoot, 'ie4uinit.exe'), ['-ClearIconCache'])
      .then(() => pexecute(path.join(sysRoot, 'ie4uinit.exe'), ['-show']))
  }

  _launchApp(path, tempDir, success) {
    this.emit('done')

    fileLog.write('Installer._launchApp() path:', path)

    child_process.spawn(path, ['--ewu-post-install', tempDir, success ? 1 : 0], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref()

    app.exit()
  }

  _postInstall(dir) {
    fs.remove(dir, function(err) {
      if (!err) {
        fileLog.write('Installer._postInstall() done')
      } else {
        fileLog.write('Installer._postInstall() error while deleting ' + dir + ':', err)
      }
    })
  }
}



/**
 * Utils
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

function pexecute(cmd, args, opts) {
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

function mkTempDir() {
  return new Promise(function(resolve, reject) {
    temp.mkdir(null, function(e, path) {
      e ? reject(e) : resolve(path)
    })
  })
}

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

function punlink(path, ignoreErrors = false) {
  return new Promise(function(resolve, reject) {
    fs.unlink(path, function(e) {
      e && !ignoreErrors ? reject(e) : resolve()
    })
  })
}

function pstat(path) {
  return new Promise(function(resolve, reject) {
    fs.stat(path, function(err, stats) {
      err ? reject(err) : resolve(stats)
    })
  })
}

function _log(...args) {
  args.unshift('<electron-windows-updater>')
  console.log.apply(console, args)
}


class FileLog {
  constructor(fileName) {
    this.stream = null
    this.fileName = 'electron-updater-log.txt'
  }

  write(...args) {
    try {
      if (!this.stream) {
        let logpath = path.join(app.getPath('temp'), this.fileName)
        try {
          let stat = fs.statSync(logpath)
          if (stat && stat.size > 102400) {
            fs.unlinkSync(logpath)
          }
        } catch (e) {}
        this.stream = fs.createWriteStream(logpath, { flags: 'a' })
      }

      let date = new Date()
      args.unshift('<'+date.getHours()+':'+date.getMinutes()+':'+date.getSeconds()+'>')

      this.stream.write(util.format.apply(null, args) + "\n")
    } catch (e) {
      _log(e)
    }
  }

  setFileName(n) {
    this.fileName = n
  }
}

const fileLog = new FileLog()


module.exports = {
  updater: new Updater(),
  installer: new Installer(),

  /**
   * @param {String} s
   */
  setLogFileName(s) {
    fileLog.setFileName(s)
  }
}
