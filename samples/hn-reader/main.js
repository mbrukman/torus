//> Hacker News reader in Torus!

//> Bootstrap the required globals from Torus, since we're not bundling
for (const exportedName in Torus) {
    window[exportedName] = Torus[exportedName];
}

//> A few constants used through the app. The root URL for the
//  Hacker News JSON API and the current time, for calculating relative datetimes.
const APP_TITLE = 'Torus Hacker News';
const HN_API_ROOT = 'https://hacker-news.firebaseio.com/v0';
const NOW = new Date();

//> Used later in styles to keep colors consistent
const BRAND_COLOR = '#1fada2';
const LIGHT_BRAND_COLOR = '#a4abbb';

//> An abstraction over the Hacker News JSON API. Given a short path, it
//  expands it out and makes sure no requests are cached by the browser,
//  then returns the result in a JSON format. `hnFetch()` also handles caching,
//  so multiple requests about the same thing only result on one request
//  using the `CACHE`, which is a map from API routes to responses.
const CACHE = new Map();
const hnFetch = async (apiPath, skipCache) => {
    if (!CACHE.has(apiPath) || skipCache) {
        const result = await fetch(HN_API_ROOT + apiPath + '.json', {
            cache: 'no-cache',
        }).then(resp => resp.json());
        CACHE.set(apiPath, result)
        return result;
    } else {
        return CACHE.get(apiPath);
    }
}

//> This app also uses my personal [screenshot service](https://github.com/thesephist/looking-glass)
//  to deliver screenshot previews for HN story links. These are API details for that service.
const LOOKING_GLASS_API_ROOT = 'https://glass.v37.co';
const LOOKING_GLASS_TOKEN = 'lg_48461186351534';

//> A function to map a site's URL to the URL for a screenshot of that site,
//  using the Looking Glass service.
const getLookingGlassScreenshotURL = siteURL => {
    return `${LOOKING_GLASS_API_ROOT}/screenshot?token=${
        LOOKING_GLASS_TOKEN}&url=${encodeURI(siteURL)}`;
}

//> Formats times into 24-hour format, which is what I personally prefer.
const formatTime = date => {
    const pad = num => num.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

//> A date formatter that does relative dates in English for the last
//  2 days.
const formatDate = unix => {
    if (!unix) {
        return 'some time ago';
    }

    const date = new Date(unix * 1000);
    const delta = (NOW - date) / 1000;
    if (delta < 60) {
        return '< 1 min ago';
    } else if (delta < 3600) {
        return `${~~(delta / 60)} min ago`;
    } else if (delta < 86400) {
        return `${~~(delta / 3600)} hr ago`;
    } else if (delta < 86400 * 2) {
        return 'yesterday';
    } else if (delta < 86400 * 3) {
        return '2 days ago';
    } else {
        return date.toLocaleDateString() + ' ' + formatTime(date);
    }
}

//> Hacker News's text posts have content in escaped HTML, so this
//  is the easiest way to display that HTML through Torus's renderer --
//  create a wrapper element, and pass that off to JDOM.
const decodeHTML = html => {
    const container = document.createElement('span');
    container.innerHTML = html
    return container;
}

//> Shortcut function to go from a username to the link to the user's profile
//  on news.ycombinator.com. I didn't make a user view in this app
//  because I personally rarely visit profiles on HN.
const stopProp = evt => evt.stopPropagation();
const userLink = username => {
    const href = `https://news.ycombinator.com/user?id=${username}`;
    return jdom`<a href="${href}" target="_blank" onclick="${stopProp}" noreferrer>${username}</a>`;
}

//> ## Records and Stores

//> In HN API, all stories, comments, and text posts inherit from `Item`.
class Item extends Record {

    /* Items have the following attrs we care about:
     *  id: number
     *  type: 'job', 'story', 'comment', 'poll/pollopt' (which we ignore)
     *  by: username in string
     *  time: unix
     *  text: text content
     *  kids: kids in display order ranked
     *  url: string
     *  score: number of votes, or #votes for pollopt
     *  title: string
     *  descendants: total comment count
     */
    fetch() {
        if (!this.loaded) {
            return hnFetch(`/item/${this.id}`).then(data => {
                const {id, ...attrs} = data;
                this.update(attrs);
            });
        } else {
            return Promise.resolve();
        }
    }

    //> Use the `type` property as a proxy to check if the rest
    //  are already loaded, so we don't double-fetch.
    get loaded() {
        return this.get('type');
    }

}

//> Story inherits from Item but doesn't have any special powers yet.
class Story extends Item {}

//> A collection of stories, used for rendering the top stories view.
class StoryStore extends StoreOf(Story) {

    //> `slug` is the URL slug for the pages on HN: top, best, newest, etc.
    constructor(slug, limit = 25) {
        super();
        this.slug = slug;
        this.limit = limit;
        this.pageNumber = 0;
    }

    //> Fetch all the new top stories from the API and reset the collection
    //  with those new stories.
    fetch() {
        return hnFetch('/' + this.slug).then(stories => {
            const storyRecords = stories.slice(
                this.pageNumber * this.limit,
                (this.pageNumber + 1) * this.limit
            ).map((id, idx) => {
                return new Story(id, {
                    order: (this.pageNumber * this.limit) + 1 + idx,
                })
            });
            this.reset(storyRecords);
            for (const story of storyRecords) {
                story.fetch();
            }
        });
    }

    //> Because the collection is paged with `limit`, we need to be able to
    //  flip to the next and previous pages. These take care of that.
    //  It could be more efficient, but it works, and flipping pages is
    //  not super frequent in the average HN reader use case, so it's not a catastrophe.
    nextPage() {
        router.go(`/page/${this.pageNumber + 1}`);
    }

    previousPage() {
        router.go(`/page/${Math.max(0, this.pageNumber - 1)}`);
    }

    gotoPage(pageNumber) {
        if (this.pageNumber !== pageNumber) {
            this.pageNumber = pageNumber;
            this.reset();
            this.fetch();
        }
    }

}

//> Comments are a kind of Item in the API
class Comment extends Item {}

//> A collection of comments
class CommentStore extends StoreOf(Comment) {

    constructor(comment_ids = [], limit = 25) {
        super();
        this.resetWith(comment_ids);
        //> Comment lists have a limit set so we don't load excessively,
        //  but it's nice to know how many were hidden away as a result. That's
        //  `hiddenCount`.
        this.hiddenCount = 0;
        this.limit = limit;
    }

    fetch() {
        for (const comment of this.records) {
            comment.fetch();
        }
    }

    //> Reset the collection with a new list of comment IDs (from a parent comment).
    //  This might seem like a wonky way to do things, but it's mirroring the API itself,
    //  which is also sort of weird.
    resetWith(comment_ids) {
        this.hiddenCount = Math.max(comment_ids.length - this.limit, 0);
        this.reset(comment_ids.slice(0, this.limit).map(id => new Comment(id)));
    }

}

//> ## Components

//> Represents a listing in the main page's list of stories
class StoryListing extends StyledComponent {

    //> Stories stay collapsed in the list, and are expanded if they're viewed individually
    init(story, _removeCallback, expanded = false) {
        this.expanded = expanded;
        this.setActiveStory = this.setActiveStory.bind(this);
        this.bind(story, data => this.render(data));
    }

    styles() {
        return css`
        display: block;
        margin-bottom: 24px;
        cursor: pointer;
        .listing {
            display: flex;
            flex-direction: row;
            align-items: center;
            justify-content: flex-start;
            width: 100%;
            &:hover .stats {
                background: ${BRAND_COLOR};
                color: #fff;
                transform: translate(0, -4px);
                &::after {
                    background: #fff;
                }
            }
        }
        .mono {
            font-family: 'Menlo', 'Monaco', monospace;
        }
        .meta {
            font-size: .9em;
            opacity: .7;
            span {
                display: inline-block;
                margin: 0 4px;
            }
        }
        .url {
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: .8em;
        }
        .content {
            color: #777;
            font-size: 1em;
        }
        a.stats {
            height: 64px;
            width: 64px;
            flex-shrink: 0;
            text-align: center;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            border-radius: 6px;
            background: #eee;
            transition: background .2s, transform .2s;
            position: relative;
            text-decoration: none;
            color: #333;
            &::after {
                content: '';
                display: block;
                height: 1px;
                background: #555;
                width: 52px;
                position: absolute;
                top: 31.5px;
                left: 6px;
            }
        }
        .score, .comments {
            height: 32px;
            width: 100%;
            line-height: 32px;
        }
        .synopsis {
            margin-left: 12px;
            flex-shrink: 1;
            overflow: hidden;
        }
        .previewWrapper {
            display: block;
            width: 100%;
            max-width: 500px;
            margin: 0 auto;
        }
        .preview {
            position: relative;
            margin: 18px auto 0 auto;
            width: 100%;
            height: 0;
            padding-bottom: 75%;
            box-shadow: 0 0 0 3px ${BRAND_COLOR};
            box-sizing: border-box;
            transition: opacity .2s;
            .loadingIndicator {
                position: absolute;
                z-index: -1;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                font-size: 1.3em;
                text-align: center;
                width: 100%;
                color: ${LIGHT_BRAND_COLOR};
            }
            img {
                box-sizing: border-box;
                width: 100%;
            }
            &:hover {
                opacity: .7;
            }
        }
        `;
    }

    getStoryPageURL() {
        return `/story/${this.record.id}`;
    }

    //> To read more about a story (read the comments), we tell the router
    //  to go to the path, so the main app view can manage the rest.
    setActiveStory(evt) {
        if (evt) {
            evt.preventDefault();
        }
        router.go(this.getStoryPageURL());
    }

    compose(attrs) {
        const text = this.expanded ? decodeHTML(attrs.text || '') : ':: text post ::';

        const score = attrs.score || 0;
        const descendants = attrs.descendants || 0;
        const title = attrs.title || '...';
        const url = attrs.url || '';
        const time = attrs.time || 0;
        const author = attrs.by || '...';

        //> PDFs don't work with puppeteer previews, so we don't check PDFs for previews
        const preview = (this.expanded && url && !url.endsWith('.pdf')) ? (
            jdom`<a class="previewWrapper" href="${url}" target="_blank" onclick="${stopProp}" noreferrer>
                <div class="preview">
                    <div class="loadingIndicator">loading link preview ...</div>
                    <img alt="Screenshot of ${url}" src="${getLookingGlassScreenshotURL(url)}" />
                </div>
            </a>`
        ) : '';

        const createTitle = (score, commentCount) => {
            const upvotes = score === 1 ? '1 upvote' : `${score} upvotes`;
            const comments = commentCount === 1 ? '1 comment' : `${commentCount} comments`;
            return upvotes + ', ' + comments;
        }

        return jdom`<li data-id=${attrs.id} onclick="${this.setActiveStory}">
            <div class="listing">
                <a class="stats mono" title="${createTitle(score, descendants)}"
                    href="${this.getStoryPageURL()}" onclick="${this.setActiveStory}">
                    <div class="score">${score}</div>
                    <div class="comments">${descendants}</div>
                </a>
                <div class="synopsis">
                    <div class="title">${attrs.order ? attrs.order + '.' : ''} ${title}</div>
                    <div class="url ${(url || !this.expanded) ? 'mono' : 'content'}">
                        ${url ? (
                            jdom`<a href="${url}" target="_blank" onclick="${stopProp}" noreferrer>${url}</a>`
                        ) : text}
                    </div>
                    <div class="meta">
                        <span class="time">${formatDate(time)}</span>
                        |
                        <span class="author">${userLink(author)}</span>
                    </div>
                </div>
            </div>
            ${preview}
        </li>`;
    }

}

//> Represents a single comment in a nested list of comments
class CommentListing extends StyledComponent {

    init(comment) {
        this.folded = true;
        //> Comments can always nest other comments as children.
        //  So each comment view has a collection of children comments.
        this.comments = new CommentStore();
        //> It's common for comment threads to never be expanded, so we
        //  optimize for the common case and don't even render the
        //  comment thread under this listing until expanded.
        this.kidsList = null;
        this.contentNode = null; // decoded HTML content, wrapped in a <span>
        this.toggleFolded = this.toggleFolded.bind(this);
        //> Anytime the `kids` property on the parent comment changes,
        //  reload the nested children comments.
        this.bind(comment, data => {
            this.comments.resetWith(data.kids || []);
            if (!this.folded) {
                this.comments.fetch();
            }
            //> The "text" value is immutable in this app,
            //  so the first time we get a non-null text value,
            //  create a contentNode from it and cache it
            //  so we don't need to keep parsing the HTML again.
            if (!this.contentNode && data.text) {
                this.contentNode = decodeHTML(data.text || '');
            }
            this.render(data);
        });
    }

    styles() {
        return css`
        background: #eee;
        margin-bottom: 12px;
        padding: 12px;
        border-radius: 6px;
        cursor: pointer;
        overflow: hidden;
        .byline {
            background: #aaa;
            padding: 1px 8px;
            border-radius: 6px;
            color: #fff;
            display: inline-block;
            margin-bottom: 8px;
            font-size: .9em;
            a {
                color: #fff;
            }
        }
        .children {
            margin-top: 12px;
            margin-left: 12px;
        }
        code {
            display: block;
            overflow: auto;
            max-width: 100%;
            font-family: 'Menlo', 'Monaco', 'Courier', monospace;
        }
        @media (max-width: 600px) {
            .text {
                font-size: .95em;
                line-height: 1.4em;
            }
        }
        `;
    }

    //> The user can click/tap on the comment block to collapse or expand
    //  the comments nested under it.
    toggleFolded(evt) {
        evt.stopPropagation();
        this.folded = !this.folded;
        if (!this.folded && this.comments) {
            this.comments.fetch();
        }
        if (!this.kidsList) {
            this.kidsList = new CommentList(this.comments);
        }
        this.render();
    }

    compose(attrs) {
        //> If a comment has been deleted, all the other information are zeroed out,
        //  so we have to treat it separately and show a placeholder.
        if (attrs.deleted) {
            return jdom`<div class="comment" onclick="${this.toggleFolded}">
                <div class="byline">unknown</div>
                <div class="text">- deleted comment -</div>
                ${!this.folded ? (jdom`<div class="children">
                    ${this.kidsList.node}
                </div>`) : ''}
            </div>`;
        }

        const time = attrs.time || 0;
        const author = attrs.by || '...';
        const kids = attrs.kids || [];

        return jdom`<div class="comment" onclick="${this.toggleFolded}">
            <div class="byline">
                ${formatDate(time)}
                |
                ${userLink(author)}
                |
                ${kids.length === 1 ? '1 reply' : kids.length + ' replies'}</div>
            <div class="text">${this.contentNode}</div>
            ${!this.folded ? (jdom`<div class="children">
                ${this.kidsList.node}
            </div>`) : ''}
        </div>`;
    }

    remove() {
        super.remove();
        this.kidsList.remove();
    }

}

//> List of comments, both at the top level and nested under other comments
class CommentList extends Styled(ListOf(CommentListing)) {

    //> <ul> elements automatically come with a default left padding we don't want.
    styles() {
        return css`padding-left: 0`;
    }

    compose() {
        const nodes = this.nodes;
        const truncatedMessage = (this.record.hiddenCount > 0 || nodes.length === 0)
            ? `...${this.record.hiddenCount || 'no'} more comments` : '';
        return jdom`<ul>
            ${nodes}
            ${truncatedMessage}
        </ul>`;
    }

}

//> List of stories that appears on the main/home page. Most of the
//  main page styles are handled in `App`, so we just use this component
// to clear margins on the `<ul>`.
class StoryList extends Styled(ListOf(StoryListing)) {

    styles() {
        return css`
        padding-left: 0;
        .loadingMessage {
            margin: 52px 0;
            font-style: italic;
        }
        `;
    }

    compose() {
        const nodes = this.nodes;
        //> On slow connections, the list of stories may take a second or two to load. Rather
        //  than awkwardly showing an empty list wit no stories, let's show a message.
        return jdom`<ul>
            ${nodes.length ? nodes : jdom`<div class="loadingMessage">loading your stories...</div>`}
        </ul>`;
    }

}

//> A `StoryPage` is the page showing an individual story and any comments under it.
//  It holds both a story listing view, as well as a comment list view.
class StoryPage extends Component {

    init(story, expanded = false) {
        //> Listing of the story this page is about, in expanded form
        this.listing = new StoryListing(story, null, expanded);
        //> A list of comments for this story
        this.comments = new CommentStore();
        this.commentList = new CommentList(this.comments);
        //> When the list of children comments for the story loads/changes, re-render
        //  the comment list.
        this.bind(story, data => {
            this.comments.resetWith(data.kids || []);
            this.comments.fetch();
            this.render(data);
        });
    }

    compose() {
        return jdom`<section>
            ${this.listing.node}
            ${this.commentList.node}
            <a href="https://news.ycombinator.com/item?id=${this.record.id}" target="_blank" noreferrer>
                See on news.ycombinator.com
            </a>
        </section>`;
    }

    remove() {
        super.remove();
        if (this.commentList) {
            this.commentList.remove();
        }
    }

}

//> Main app view
class App extends StyledComponent {

    init(router) {
        //> Active story is null iff we're looking at the main page / list of stories
        this.activeStory = null;
        this.activePage = null;

        //> We load the top stories list from the HN API. There are others, but
        //  I really never read them so yeah.
        this.stories = new StoryStore('topstories', 20);
        this.list = new StoryList(this.stories);
        //> Fetch the first page of stories
        this.stories.fetch();

        this.nextPage = this.nextPage.bind(this);
        this.previousPage = this.previousPage.bind(this);
        this.homeClick = this.homeClick.bind(this);

        //> Define our routing actions.
        this.bind(router, ([name, params]) => {
            switch (name) {
                case 'story': {
                    let story = this.stories.find(+params.storyID);
                    //> Story sometimes doesn't exist in our collection,
                    //  if we're going directly to a story link from another page.
                    //  In this case, we want to just fetch information about the
                    //  story itself manually.
                    if (!story) {
                        story = new Story(+params.storyID);
                        story.fetch().then(() => {
                            document.title = `${story.get('title')} | ${APP_TITLE}`;
                        });
                    } else {
                        document.title = `${story.get('title')} | ${APP_TITLE}`;
                    }
                    this.setActiveStory(story);
                    break;
                }
                case 'page': {
                    const pageNumber = isNaN(+params.pageNumber) ? 0 : +params.pageNumber;
                    if (pageNumber === 0) {
                        router.go('/', {replace: true});
                    } else {
                        this.setActiveStory(null);
                        document.title = APP_TITLE;
                        this.stories.gotoPage(pageNumber);
                    }
                    break;
                }
                default:
                    //> The default route is just the main page, `'/'`.
                    this.setActiveStory(null);
                    document.title = APP_TITLE;
                    this.stories.gotoPage(0);
                    break;
            }
        });
    }

    styles() {
        return css`
        font-family: system-ui, 'Helvetica', 'Roboto', sans-serif;
        color: #333;
        box-sizing: border-box;
        padding: 14px;
        padding-bottom: 24px;
        line-height: 1.5em;
        max-width: 800px;
        margin: 0 auto;
        h1 {
            cursor: pointer;
        }
        a {
            color: ${BRAND_COLOR};
            &:visited {
                color: ${LIGHT_BRAND_COLOR}
            }
        }
        a.pageLink {
            display: inline-block;
            color: #fff;
            background: ${BRAND_COLOR};
            text-decoration: none;
            padding: 6px 10px;
            border: 0;
            font-size: 1em;
            margin-right: 12px;
            border-radius: 6px;
            transition: opacity .2s;
            &:hover {
                opacity: .7;
            }
        }
        footer {
            margin: 32px 0;
            color: #aaa;
            font-style: italic;
        }
        `;
    }

    //> Used to set an active story for the whole app. Called by the router logic.
    setActiveStory(story) {
        if (this.activeStory !== story) {
            this.activeStory = story;
            if (story) {
                this.activePage = new StoryPage(story, true);
            } else {
                this.activePage = null;
            }
            this.resetScroll();
            this.render();
        }
    }

    nextPage(evt) {
        evt.preventDefault();
        this.stories.nextPage();
        this.render();
        this.resetScroll();
    }

    previousPage(evt) {
        evt.preventDefault();
        this.stories.previousPage();
        this.render();
        this.resetScroll();
    }

    homeClick() {
        router.go('/');
    }

    //> When views switch, it's nice to automatically scroll up to the top of the page
    //  to read the new stuff. This does that.
    resetScroll() {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                document.scrollingElement.scrollTop = 0;
            });
        });
    }

    compose() {
        return jdom`<main>
            <h1 onclick="${this.homeClick}">
                ${this.activePage ? '👈' : '🏠'} Hacker News
            </h1>
            ${this.activeStory ? (
                this.activePage.node
            ) : (
                jdom`<div>
                    ${this.list.node}
                    <a class="pageLink" href="/page/${Math.max(0, this.stories.pageNumber - 1)}"
                        title="previous page"
                        onclick="${this.previousPage}">👈 prev</button>
                    <a class="pageLink" href="/page/${this.stories.pageNumber + 1}"
                        title="next page"
                        onclick="${this.nextPage}">next 👉</button>
                </div>`
            )}
            <footer>This HN reader was made with
                <a href="https://linus.zone/torus" target="_blank" noreferrer>Torus</a>
                and &#60;3 by
                <a href="https://linus.zone/now" target="_blank" noreferrer>Linus</a>
            </footer>
        </main>`;
    }

}

//> Let's define our routes!
const router = new Router({
    story: '/story/:storyID',
    page: '/page/:pageNumber',
    default: '/',
});

//> Create the app instance, which we define earlier to be
//  called with a router, and mount it to the DOM.
const app = new App(router);
document.body.appendChild(app.node);
