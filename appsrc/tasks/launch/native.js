
import ospath from 'path'
import invariant from 'invariant'

import {map} from 'underline'
import shellQuote from 'shell-quote'

import poker from './poker'

import urls from '../../constants/urls'
import linuxSandboxTemplate from '../../constants/sandbox-policies/linux-template'

import * as actions from '../../actions'

import store from '../../store'
import sandbox from '../../util/sandbox'
import os from '../../util/os'
import sf from '../../util/sf'
import spawn from '../../util/spawn'
import fetch from '../../util/fetch'
import pathmaker from '../../util/pathmaker'

import mklog from '../../util/log'
const log = mklog('tasks/launch/native')

import {Crash} from '../errors'

export default async function launch (out, opts) {
  const {cave, market, credentials, env} = opts
  invariant(cave, 'launch-native has cave')
  invariant(cave, 'launch-native has env')
  log(opts, `launching cave in '${cave.installLocation}' / '${cave.installFolder}'`)

  invariant(credentials, 'launch-native has credentials')

  const game = await fetch.gameLazily(market, credentials, cave.gameId, {game: cave.game})
  invariant(game, 'was able to fetch game properly')

  const appPath = pathmaker.appPath(cave)
  let exePath
  let args = []

  const manifestPath = ospath.join(appPath, '.itch.toml')
  const hasManifest = await sf.exists(manifestPath)
  if (opts.manifestAction) {
    const action = opts.manifestAction

    log(opts, `Should launch ${JSON.stringify(action, 0, 2)}`)
    const actionPath = action.path
    exePath = ospath.join(appPath, actionPath)
  } else {
    log(opts, 'No action picked')
  }

  if (!exePath) {
    const pokerOpts = {
      ...opts,
      appPath
    }
    exePath = await poker(pokerOpts)
  }

  if (!exePath) {
    const err = new Error(`No executables found (${hasManifest ? 'with' : 'without'} manifest)`)
    err.reason = ['game.install.no_executables_found']
    throw err
  }

  if (/\.jar$/i.test(exePath)) {
    log(opts, 'Launching .jar')
    args.push('-jar')
    args.push(exePath)
    exePath = 'java'
  }

  const platform = os.platform()
  log(opts, `launching '${exePath}' on '${platform}' with args '${args.join(' ')}'`)
  const argString = args::map(spawn.escapePath).join(' ')

  const {isolateApps} = opts.preferences
  if (isolateApps) {
    const checkRes = await sandbox.check()
    if (checkRes.errors.length > 0) {
      throw new Error(`error(s) while checking for sandbox: ${checkRes.errors.join(', ')}`)
    }

    if (checkRes.needs.length > 0) {
      if (!opts.sandboxBlessing) {
        const platform = os.itchPlatform()

        store.dispatch(actions.openModal({
          title: ['sandbox.setup.title'],
          message: [`sandbox.setup.${platform}.message`],
          detail: [`sandbox.setup.${platform}.detail`],
          buttons: [
            {
              label: ['sandbox.setup.proceed'],
              action: actions.queueGame({game, extraOpts: {sandboxBlessing: true}}),
              icon: 'checkmark'
            },
            {
              label: ['docs.learn_more'],
              action: actions.openUrl(urls[`${platform}SandboxSetup`]),
              icon: 'earth',
              className: 'secondary'
            },
            'cancel'
          ]
        }))
        return
      }

      const installRes = await sandbox.install(opts, checkRes.needs)
      if (installRes.errors.length > 0) {
        throw new Error(`error(s) while installing sandbox: ${installRes.errors.join(', ')}`)
      }
    }
  }

  let fullExec = exePath
  if (platform === 'darwin') {
    const isBundle = isAppBundle(exePath)
    if (isBundle) {
      fullExec = await spawn.getOutput({
        command: 'activate',
        args: ['--print-bundle-executable-path', exePath],
        logger: opts.logger
      })
    }

    if (isolateApps) {
      log(opts, 'app isolation enabled')

      const sandboxOpts = {
        ...opts,
        game,
        appPath,
        exePath,
        fullExec,
        argString,
        isBundle
      }

      await sandbox.within(sandboxOpts, async function ({fakeApp}) {
        await doSpawn(fullExec, `open -W ${spawn.escapePath(fakeApp)}`, env, opts)
      })
    } else {
      log(opts, 'no app isolation')
      if (isBundle) {
        await doSpawn(fullExec, `open -W ${spawn.escapePath(exePath)} --args ${argString}`, env, opts)
      } else {
        await doSpawn(fullExec, `${spawn.escapePath(exePath)} ${argString}`, env, opts)
      }
    }
  } else if (platform === 'win32') {
    let cmd = `${spawn.escapePath(exePath)}`
    if (argString.length > 0) {
      cmd += ` ${argString}`
    }

    const grantPath = appPath
    if (isolateApps) {
      const grantRes = await spawn.getOutput({
        command: 'icacls',
        args: [ grantPath, '/grant', 'itch-player:F', '/T', '/Q' ],
        logger: opts.logger
      })
      log(opts, `grant output:\n${grantRes}`)

      cmd = `elevate --runas itch-player salt ${cmd}`
    }
    await doSpawn(exePath, cmd, env, opts)

    if (isolateApps) {
      const denyRes = await spawn.getOutput({
        command: 'icacls',
        args: [ grantPath, '/deny', 'itch-player:F', '/T', '/Q' ],
        logger: opts.logger
      })
      log(opts, `deny output:\n${denyRes}`)
    }
  } else if (platform === 'linux') {
    let cmd = `${spawn.escapePath(exePath)}`
    if (argString.length > 0) {
      cmd += ` ${argString}`
    }
    if (isolateApps) {
      log(opts, 'generating firejail profile')
      const sandboxProfilePath = ospath.join(appPath, '.itch', 'isolate-app.profile')

      const sandboxSource = linuxSandboxTemplate
      await sf.writeFile(sandboxProfilePath, sandboxSource)

      cmd = `firejail "--profile=${sandboxProfilePath}" -- ${cmd}`
      await doSpawn(exePath, cmd, env, opts)
    } else {
      await doSpawn(exePath, cmd, env, opts)
    }
  } else {
    throw new Error(`unsupported platform: ${platform}`)
  }
}

async function doSpawn (exePath, fullCommand, env, opts) {
  log(opts, `doSpawn ${fullCommand}`)

  const cwd = ospath.dirname(exePath)
  log(opts, `Working directory: ${cwd}`)

  const args = shellQuote.parse(fullCommand)
  const command = args.shift()
  log(opts, `Command: ${command}`)
  log(opts, `Args: ${JSON.stringify(args, 0, 2)}`)
  log(opts, `Env keys: ${JSON.stringify(Object.keys(env), 0, 2)}`)

  const code = await spawn({
    command,
    args,
    onToken: (tok) => log(opts, `stdout: ${tok}`),
    onErrToken: (tok) => log(opts, `stderr: ${tok}`),
    opts: {
      env: {
        ...process.env,
        ...env
      },
      cwd
    }
  })

  if (code !== 0) {
    const error = `process exited with code ${code}`
    throw new Crash({exePath, error})
  }
  return 'child completed successfully'
}

function isAppBundle (exePath) {
  return /\.app\/?$/.test(exePath.toLowerCase())
}
