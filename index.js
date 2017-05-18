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

const NOOP = function() {}

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
    // override this method
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
      //_log('downloading ' + this.updateData.url + ' to ' + this.downloadPath)
      return this._download(this.updateData.url, this.downloadPath)
    })
    .then(() => {
      return mkTempDir()
      .then(dir => {
        //_log('unpacking to ' + dir)
        this.unpackDir = dir
        return pExtractZip(this.downloadPath, dir)
      })
    })
    .then(() => punlink(this.downloadPath, true))
    .then(() => {
      //_log('an update has been successfully downloaded and unpacked')
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
      let p = parseUrl(src)
      let module = ( p.protocol == 'https:' ? https : http )

      let request = module.request({
        method: 'GET',
        host: p.host,
        path: p.path
      })

      request.on('response', (response) => {
        if (response.statusCode != 200) {
          reject(new Error("HTTP status code is " + response.statusCode))
          return
        }

        let downloaded = 0
        let progressTs = 0

        let file = fs.createWriteStream(dst)
        response.pipe(file)

        file.on('finish', () => {
          this.emit('download-progress', 100)
          response.unpipe()
          resolve()
        })

        response.on('data', buf => {
          try {
            downloaded += buf.length
            let now = Date.now()
            if (now - progressTs > PROGRESS_PERIOD) {
              progressTs = now
              this.emit('download-progress', downloaded / this.updateData.size * 100)
            }
          } catch (e) {
            console.error(e)
          }
        })
      })

      request.on('error', function(error) {
        file.close(function() {
          fs.unlink(dst)
          reject(error)
        })
      })

      request.end()
    })
  }
}

class WindowsUpdater extends Updater {
  constructor() {
    super()
    this.cscriptPath = path.join(require('get-system32-path').GetSystem32Path(), 'cscript.exe')
    this.exeName = null
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

    fileLog.write('WindowsUpdater::quitAndInstall() running ' + this.cscriptPath + ' ' + args.join(' '))

    child_process.spawn(this.cscriptPath, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref()

    app.exit(0)
    process.exit(0)
  }
}

class LinuxUpdater extends Updater {
  quitAndInstall() {
    let args = [
      '--ewu-install',
      this.unpackDir, // source dir
    ]

    fileLog.write('LinuxUpdater::quitAndInstall() running ' + process.execPath + ' ' + args.join(' '))

    child_process.spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref()

    app.exit(0)
    process.exit(0)
  }
}

const INSTALLER_PREFIX = '--ewu-'
class Installer extends EventEmitter {
  constructor() {
    super()
    this.copyFailed = false
  }

  process() {
    // override this method
  }

  /**
   * @return {Object}
   *   String task
   *   Array<String> args
   */
  parseArguments() {
    let task = null, args = []
    for (let i = 1; i < process.argv.length; i++) {
      let a = process.argv[i]
      if (!a.startsWith(INSTALLER_PREFIX)) continue

      task = a.substr(INSTALLER_PREFIX.length)
      if (this.taskArgsCount[task] === undefined) continue

      let argsCount = this.taskArgsCount[task]
      if (argsCount) {
        args = process.argv.slice(i+1, i+1+argsCount)
      }
      break
    }

    return { task, args }
  }

  launchApp() {
    this.emit('done')
    // override this method
  }
}

class WindowsInstaller extends Installer {
  constructor() {
    super()
    this.sysRoot = require('get-system32-path').GetSystem32Path()
    this.taskArgsCount = {
      'install': 2,
      'post-install': 2
    }

    process.on('uncaughtException', (err) => {
      fileLog.write(err)
      app.exit(0)
      process.exit(0)
    })
  }

  process() {
    super.process()

    let { task, args } = this.parseArguments()
    if (!task) {
      return false
    }

    fileLog.write('WindowsInstaller::process() argv:', process.argv.join(' '))

    switch (task) {
      case 'install': {
        let [ dst, exeName ] = args
        let src = path.dirname(process.execPath)

        let noAsar = process.noAsar
        process.noAsar = true
        this.copy(src, dst, exeName)
        .then(() => {
          process.noAsar = noAsar
        })
        .then(() => this.clearIconCache())
        .then(() => this.launchApp(path.join(dst, exeName), src))
        .catch(e => {
          fileLog.write(e)
          app.exit(0)
          process.exit(0)
        })
        return true
      }

      case 'post-install': {
        let [ dir, copyResult ] = args
        this.copyFailed = parseInt(copyResult, 10) == 0

        let noAsar = process.noAsar
        process.noAsar = true
        fs.remove(dir, function(err) {
          process.noAsar = noAsar
          if (!err) {
            fileLog.write('WindowsInstaller::postInstall() done')
          } else {
            fileLog.write('WindowsInstaller::postInstall() error while deleting ' + dir + ':', err)
          }
        })
        break
      }
    }
  }

  copy(src, dst, exeName) {
    const maxTries = 20
    function tryToCopy(iter = 0) {
      return pcopy(src, dst)
      .then(() => {
        fileLog.write('WindowsInstaller::copy(): succeeded on iteration ' + iter)
      })
      .catch(err => {
        fileLog.write('WindowsInstaller::copy(): failed on iteration ' + iter)
        if (iter < maxTries) {
          return psleep(1000).then(() => tryToCopy(iter+1))
        } else {
          throw err
        }
      })
    }

    return tryToCopy()
    .catch(err => {
      fileLog.write('WindowsInstaller::copy("' + src + '", "' + dst + '") failed:', err)
      this.copyFailed = true
    })
  }

  launchApp(exe, tempDir) {
    super.launchApp()
    fileLog.write('WindowsInstaller::launchApp() path:', exe)

    let success = !this.copyFailed
    child_process.spawn(exe, ['--ewu-post-install', path.resolve(tempDir), (success ? '1' : '0')], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref()

    app.exit(0)
    process.exit(0)
  }

  clearIconCache() {
    return pexecute(path.join(this.sysRoot, 'ie4uinit.exe'), ['-ClearIconCache'])
      .then(() => pexecute(path.join(this.sysRoot, 'ie4uinit.exe'), ['-show']))
  }
}

class LinuxInstaller extends Installer {
  constructor() {
    super()
    this.taskArgsCount = {
      'install': 1,
      'post-install': 1
    }
  }

  process(opts = {}) {
    super.process()

    const defaultOpts = {
      afterCopy: NOOP
    }
    opts = Object.assign(defaultOpts, opts)

    let { task, args } = this.parseArguments()
    if (!task) {
      return false
    }

    fileLog.write('LinuxInstaller::process() argv:', process.argv.join(' '))

    switch (task) {
      case 'install': {
        let src = args[0]
        let dst = path.dirname(process.execPath)

        let noAsar = process.noAsar
        process.noAsar = true
        this.copy(src, dst)
        .then(() => {
          let res
          try {
            res = opts.afterCopy(src)
          } catch (e) {
            fileLog.write(e)
          }

          if (res instanceof Promise) {
            return res.catch(err => {
              fileLog.write(err)
            })
          }
        })
        .then(() => premove(src))
        .then(() => {
          process.noAsar = noAsar
          return this.launchApp()
        })
        .catch(e => {
          fileLog.write(e)
          app.exit(0)
          process.exit(0)
        })
        return true
      }

      case 'post-install': {
        let copyResult = args[0]
        this.copyFailed = parseInt(copyResult, 10) == 0
        break
      }
    }
  }

  copy(src, dst) {
    return pcopy(src, dst)
    .catch(err => {
      fileLog.write('LinuxInstaller::copy("' + src + '", "' + dst + '") failed:', err)
      this.copyFailed = true
    })
  }

  launchApp() {
    super.launchApp()
    fileLog.write('LinuxInstaller::launchApp()')

    child_process.spawn(process.execPath, ['--ewu-post-install', (this.copyFailed ? '0' : '1')], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref()

    app.exit(0)
    process.exit(0)
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
      path: p.path,
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

    req.on('error', function(error) {
      reject(error)
    })

    req.end()
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

function pcopy(src, dst, opts = {}) {
  return new Promise(function(resolve, reject) {
    fs.copy(src, dst, opts, function(err) {
      !err ? resolve() : reject(err)
    })
  })
}

function premove(dir) {
  return new Promise(function(resolve, reject) {
    fs.remove(dir, function(err) {
      !err ? resolve() : reject(err)
    })
  })
}

function psleep(timeout) {
  return new Promise(function(resolve, reject) {
    setTimeout(function() {
      resolve()
    }, timeout)
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

let updater, installer, fileLog = new FileLog()
switch (process.platform) {
  case 'linux':
    updater = new LinuxUpdater()
    installer = new LinuxInstaller()
    break

  case 'win32':
    updater = new WindowsUpdater()
    installer = new WindowsInstaller()
    break
}

module.exports = {
  updater,
  installer,

  /**
   * @param {String} s
   */
  setLogFileName(s) {
    fileLog.setFileName(s)
  }
}
