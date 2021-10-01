import { Octokit } from '@octokit/core';
import moment from 'moment';

import {
  Organization,
  PublicUser,
  RepoWithEvents,
  ScrapingResult,
} from 'interfaces';

import RepoBlocked from 'errors/RepoBlocked';

import { getFormattedTime, getPreviousWeek } from 'utils/time';
import { readJSONFile, saveJSONFile } from 'utils/json';
import requestWrapper from 'utils/requestWrapper';

interface ScraperConfig {
  octokit: Octokit;
  baseQuery: string;
  resultLocation: string;
}

interface IScraper {
  setup({ octokit, baseQuery, resultLocation }: ScraperConfig): void;
  run(): Promise<void>;
}

export default class Scraper implements IScraper {
  private octokit: Octokit;
  private baseQuery: string;
  private resultLocation: string;
  private nextPageToScrape: number;
  private date: string;
  private organizations: Organization[];
  private totalCount: number;
  private oldestOrgDate: string;
  private ready: Promise<boolean>;

  private readFile() {
    try {
      const result = readJSONFile<ScrapingResult>(this.resultLocation);
      this.nextPageToScrape = result.nextPageToScrape;
      this.date = result.searchingDate;
      this.organizations = result.organizations;
    } catch {
      this.nextPageToScrape = 1;
      this.date = moment().format('YYYY-MM-DD');
      this.organizations = [];
    }
  }

  private saveToFile() {
    const result = {
      nextPageToScrape: this.nextPageToScrape,
      searchingDate: this.date,
      organizations: this.organizations,
    };

    saveJSONFile<ScrapingResult>(this.resultLocation, result);
  }

  private readyPromise() {
    this.ready = new Promise(async (res) => {
      const {
        items: [oldestOrg],
        total_count,
      } = await requestWrapper(() =>
        this.octokit.request('GET /search/users', {
          q: this.baseQuery,
          sort: 'joined',
          order: 'asc',
        })
      );

      const oldestData = await requestWrapper(() =>
        this.octokit.request('GET /users/{username}', {
          username: oldestOrg.login,
        })
      );
      const publicUser = oldestData as PublicUser;

      this.totalCount = total_count;
      this.oldestOrgDate = publicUser.created_at;

      return res(true);
    });
  }

  public setup({ octokit, baseQuery, resultLocation }: ScraperConfig) {
    this.octokit = octokit;
    this.baseQuery = baseQuery;
    this.resultLocation = resultLocation;

    this.readFile();

    this.readyPromise();
  }

  public async run() {
    await this.ready;

    while (moment(this.date, 'YYYY-MM-DD').isAfter(this.oldestOrgDate)) {
      const dateCreated = `created:${getPreviousWeek(this.date)}..${this.date}`;

      const orgs = await requestWrapper(() =>
        this.octokit.request('GET /search/users', {
          q: `${this.baseQuery} ${dateCreated}`,
          page: this.nextPageToScrape,
          per_page: 100,
        })
      );

      if (!orgs.items.length) {
        this.date = getPreviousWeek(this.date);
        this.nextPageToScrape = 1;

        this.saveToFile();

        continue;
      }

      for (const organization of orgs.items) {
        if (this.organizations.some((o) => o.login === organization.login))
          continue;

        const rawRepos = await requestWrapper(() =>
          this.octokit.request('GET /users/{username}/repos', {
            username: organization.login,
          })
        );

        if (!rawRepos.length) continue;

        const data = await requestWrapper(() =>
          this.octokit.request('GET /users/{username}', {
            username: organization.login,
          })
        );
        const publicUser = data as PublicUser;

        const repos: RepoWithEvents[] = [];

        for (const repo of rawRepos) {
          let last_90_days_events_count: number;

          try {
            const events = await requestWrapper(() =>
              this.octokit.request('GET /repos/{owner}/{repo}/events', {
                owner: organization.login,
                repo: repo.name,
              })
            );
            last_90_days_events_count = events.length;
          } catch (err) {
            if (!(err instanceof RepoBlocked)) throw err;
            last_90_days_events_count = 0;
          }

          repos.push({ ...repo, last_90_days_events_count });
        }

        const totalRepoStars = repos.reduce(
          (acc, r) => acc + (r.stargazers_count ?? 0),
          0
        );
        const totalRepoWatchers = repos.reduce(
          (acc, r) => acc + (r.watchers_count ?? 0),
          0
        );
        const totalRepoForks = repos.reduce(
          (acc, r) => acc + (r.forks_count ?? 0),
          0
        );
        const totalRepoOpenIssues = repos.reduce(
          (acc, r) => acc + (r.open_issues_count ?? 0),
          0
        );
        const totalRepoLast90DaysEvents = repos.reduce(
          (acc, r) => acc + r.last_90_days_events_count,
          0
        );

        const {
          login,
          id,
          avatar_url,
          html_url,
          name,
          company,
          blog,
          location,
          email,
          hireable,
          bio,
          twitter_username,
          public_repos,
          followers,
          following,
          created_at,
          updated_at,
        } = publicUser;

        const org: Organization = {
          login,
          id,
          avatarUrl: avatar_url,
          htmlUrl: html_url,
          name,
          company,
          blog,
          location,
          email,
          hireable,
          bio,
          twitterUsername: twitter_username ?? null,
          publicRepos: public_repos,
          followers,
          following,
          createdAt: created_at,
          updatedAt: updated_at,
          totalRepoStars,
          totalRepoWatchers,
          totalRepoForks,
          totalRepoOpenIssues,
          totalRepoLast90DaysEvents,
        };

        this.organizations = [...this.organizations, org];

        this.saveToFile();

        const count = this.organizations.length;
        const stats = `[${count}/${this.totalCount} - ${getFormattedTime()}]`;
        const info = `${org.name} (${org.login})`;
        const numbers = `${totalRepoLast90DaysEvents} eventos recentes\t${totalRepoStars} estrelas em seus repositórios`;

        console.log(`\n${stats} ${info}:\n${numbers}`);
      }

      this.nextPageToScrape++;

      this.saveToFile();
    }

    console.log(`\n[${getFormattedTime()}] Processo finalizado.\n`);
  }
}
