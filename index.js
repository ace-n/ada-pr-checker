#!/usr/bin/env node

`use strict`;

const console = require('console'); // Enable proxyquire stubbing

const Configstore = require('configstore');
const config = new Configstore('ada-pr-checker');

const chalk = require('chalk');
const moment = require('moment');
const arrDedupe = require('array-uniq');
const {parseDate} = require('chrono-node');
const pLimit = require('p-limit');

const github = require('./lib/github');
const {sortedLog} = require('./lib/sortedLog');

const _validateConfigKey = key => {
  const SUPPORTED_KEYS = [
    'githubAuthors',
    'githubOrg',
    'githubAuthToken',
    'cacheExpiry',
    'allGithubRepos',
  ];

  if (!SUPPORTED_KEYS.includes(key)) {
    console.error('Unknown key name! Supported values are:');
    for (const supportedKey of SUPPORTED_KEYS) {
      console.error(`- ${supportedKey}`);
    }

    return false;
  } else {
    return true;
  }
};

const _configKeyIsArray = key =>
  ['allGithubRepos', 'githubAuthors'].includes(key);

const MAX_CONCURRENT_REPO_CHECKS = 5; // To avoid GitHub rate limits

const _arrayIsWildcard = x => x.length === 1 && x[0] === '@';
const _prefix = (user, repo) => `${chalk.magenta(user)} -> ${chalk.cyan(repo)}`;
const _negateDate = dateStr => {
  // Parse a human-readable duration (x) and convert it
  // to a time in the past (`${x} before right now`)
  const parsed = parseDate(dateStr);
  const now = moment();

  if (parsed) {
    const duration = parsed - now;
    return now - duration;
  } else {
    throw new Error('Invalid maxCacheAge.');
  }
};

/*
 * Print out the status of PRs for the given GitHub repo
 *
 * @param org (string)
 *   The GitHub org (or user) the PRs were made to.
 *   Can NOT be a wildcard.
 * @param repo (string)
 *   The GitHub repo name to check. Can NOT be a wildcard.
 * @param users (string)
 *   The users to check, or a wildcard ('@').
 * @param maxCacheAge (int)
 *   The maximum cache age (as a UNIX timestamp)
 */
const _checkPRsForRepo = async (org, repo, users, maxCacheAge) => {
  // Get PRs for repo
  const pullData = await github.getRepo(org, repo, maxCacheAge);
  let pulls = pullData.map(pr => {
    return {
      id: pr.number,
      user: pr.user.login,
    };
  });

  if (!_arrayIsWildcard(users)) {
    // Filter users
    pulls = pulls.filter(pr => users.includes(pr.user));
  } else {
    // Get all usernames
    users = arrDedupe(pulls.map(pr => pr.user));
  }

  // Check for missing PRs
  for (const user of users) {
    if (!pulls.some(pr => pr.user === user)) {
      sortedLog(`${_prefix(user, repo)}: ${chalk.white('no pulls found')}`);
    }
  }

  // Get reviews for PR(s)
  const reviewsForPulls = await Promise.all(
    pulls.map(pr => {
      return github.getReviews(org, repo, pr.id, maxCacheAge);
    })
  );

  for (let i = 0; i < reviewsForPulls.length; i++) {
    const pr = pulls[i];
    const reviews = reviewsForPulls[i];

    const prefix = _prefix(pr.user, repo);

    if (reviews.length < 1) {
      const prUrl = `https://github.com/${org}/${repo}/pull/${pr.id}/changes`;
      const cloneCmd = `git clone https://github.com/${pr.user}/${repo} ${
        pr.user
      }/${repo}`;

      sortedLog(
        `${prefix}: ${chalk.bold.bgRed.white('needs review!')}\n` +
          `\t${chalk.white.bold.bgRed(prUrl)}\n` +
          `\t${chalk.cyan(cloneCmd)}\n`
      );
    } else {
      // Check review status
      const review = reviews[0];
      sortedLog(
        `${prefix}: ${chalk.green('reviewed')}, status: ${review.state}`
      );
    }
  }
};

const cli = require('yargs')
  .demandCommand(1)
  .command('setConfig <key> <values...>', 'Sets a config value.', {}, opts => {
    if (!_validateConfigKey(opts.key)) {
      return;
    }

    if (!_configKeyIsArray(opts.key)) {
      opts.values = opts.values[0];
    }

    config.set(opts.key, opts.values);
  })
  .command('getConfig <key>', 'Gets a config value.', {}, opts => {
    console.log(config.get(opts.key));
  })
  .command('deleteConfig <key>', 'Deletes a config value.', {}, opts => {
    if (!_validateConfigKey(opts.key)) {
      return;
    }

    config.set(opts.key, undefined);
  })

  .command('listConfig', 'List all config values', {}, () => {
    console.log(config.all);
  })
  .command(
    'check <repos...>',
    'Checks for PR status',
    {
      authors: {
        type: 'array',
        alias: 'a',
        default: config.get('githubAuthors') || '@',
      },
      org: {
        type: 'string',
        alias: 'o',
        global: 'true',
        default: () => {
          const cohort = Math.floor(
            moment().diff(moment('2013-06-01'), 'months') / 6
          );
          const autoOrgName = `Ada-C${cohort}`;
          const cfgOrg = config.get('githubOrg');

          if (cfgOrg && cfgOrg.startsWith('Ada-C') && cfgOrg !== autoOrgName) {
            console.log(
              chalk.red.bold('WARN GitHub org name may be outdated!')
            );
            console.log(chalk.red.bold(`\t${cfgOrg} --> ${autoOrgName}`));
          }

          return cfgOrg || autoOrgName;
        },
      },
      maxCacheAge: {
        type: 'string',
        alias: 'c',
        default: config.get('cacheExpiry') || '60 minutes',
        coerce: age => _negateDate(age),
      },
    },
    async opts => {
      let repos = opts.repos;
      if (_arrayIsWildcard(repos)) {
        repos = config.get('allGithubRepos') || [];
      }

      const limit = pLimit(MAX_CONCURRENT_REPO_CHECKS);
      const promises = repos.map(repo =>
        limit(() =>
          _checkPRsForRepo(opts.org, repo, opts.authors, opts.maxCacheAge)
        )
      );

      return Promise.all(promises);
    }
  )
  .wrap(80)
  .example(
    'prcheck setConfig githubAuthToken MY_AUTH_TOKEN',
    'Set your GitHub auth token'
  )
  .example(
    'prcheck setConfig githubAuthors ace-n',
    'Set a GitHub author to check by default'
  )
  .example(
    'prcheck setConfig githubAuthors ace-n shrutivanw',
    'Set multiple GitHub authors to check by default'
  )
  .example(
    'prcheck check repo_1 repo_2',
    'Search for PRs from repo_1 and repo_2. Filter authors based on config.json (default: no filter)'
  )
  .example(
    'prcheck check repo_1 repo_2 --authors user_1 user_2',
    'Search for PRs from repo_1 and repo_2 with authors user_1 and user_2'
  )
  .example(
    'prcheck check @ --authors user_1 user_2',
    'Search for PRs from any repo with authors user_1 and user_2'
  )
  .example(
    'prcheck check @ --authors @',
    'Search for PRs from all repos authored by anyone'
  )
  .recommendCommands()
  .help()
  .strict();

exports.cli = cli; // for testing

if (module === require.main) {
  cli.parse(process.argv.slice(2)); // eslint-disable-line
}
