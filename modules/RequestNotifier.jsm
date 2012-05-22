/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

/**
 * @fileOverview Stores Adblock Plus data to be attached to a window.
 */

var EXPORTED_SYMBOLS = ["RequestNotifier"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

let baseURL = "chrome://adblockplus-modules/content/";
Cu.import(baseURL + "Utils.jsm");
Cu.import(baseURL + "FilterClasses.jsm");
Utils.runAsync(Cu.import, Cu, baseURL + "ContentPolicy.jsm");  // delay to avoid circular imports

let nodeData = new WeakMap();
let windowStats = new WeakMap();
let windowSelection = new WeakMap();

/**
 * List of notifiers in use - these notifiers need to receive notifications on
 * new requests.
 * @type RequestNotifier[]
 */
let activeNotifiers = [];

/**
 * Creates a notifier object for a particular window. After creation the window
 * will first be scanned for previously saved requests. Once that scan is
 * complete only new requests for this window will be reported.
 * @param {Window} wnd  window to attach the notifier to
 * @param {Function} listener  listener to be called whenever a new request is found
 * @param {Object} [listenerObj]  "this" pointer to be used when calling the listener
 */
function RequestNotifier(wnd, listener, listenerObj)
{
	this.window = wnd;
	this.listener = listener;
	this.listenerObj = listenerObj || null;
	activeNotifiers.push(this);
	if (wnd)
		this.startScan(wnd);
	else
		this.scanComplete = true;
}
RequestNotifier.prototype =
{
	/**
	 * The window this notifier is associated with.
	 * @type Window
	 */
	window: null,

	/**
	 * The listener to be called when a new request is found.
	 * @type Function
	 */
	listener: null,

	/**
	 * "this" pointer to be used when calling the listener.
	 * @type Object
	 */
	listenerObj: null,

	/**
	 * Will be set to true once the initial window scan is complete.
	 * @type Boolean
	 */
	scanComplete: false,

	/**
	 * Shuts down the notifier once it is no longer used. The listener
	 * will no longer be called after that.
	 */
	shutdown: function()
	{
		delete this.window;
		delete this.listener;
		delete this.listenerObj;

		for (let i = activeNotifiers.length - 1; i >= 0; i--)
			if (activeNotifiers[i] == this)
				activeNotifiers.splice(i, 1);
	},

	/**
	 * Notifies listener about a new request.
	 */
	notifyListener: function(/**Window*/ wnd, /**Node*/ node, /**RequestEntry*/ entry)
	{
		this.listener.call(this.listenerObj, wnd, node, entry, this.scanComplete);
	},

	/**
	 * Number of currently posted scan events (will be 0 when the scan finishes
	 * running).
	 */
	eventsPosted: 0,

	/**
	 * Starts the initial scan of the window (will recurse into frames).
	 * @param {Window} wnd  the window to be scanned
	 */
	startScan: function(wnd)
	{
		let currentThread = Utils.threadManager.currentThread;

		let doc = wnd.document;
		let walker = doc.createTreeWalker(doc, Ci.nsIDOMNodeFilter.SHOW_ELEMENT, null, false);

		let runnable =
		{
			notifier: null,

			run: function()
			{
				if (!this.notifier.listener)
					return;

				let node = walker.currentNode;
				let data = nodeData.get(node);
				if (typeof data != "undefined")
					for (let i = data.length - 1; i >= 0; i--)
						this.notifier.notifyListener(wnd, node, data[i]);

				if (walker.nextNode())
					currentThread.dispatch(runnable, Ci.nsIEventTarget.DISPATCH_NORMAL);
				else
				{
					// Done with the current window, start the scan for its frames
					for (let i = 0; i < wnd.frames.length; i++)
						this.notifier.startScan(wnd.frames[i]);

					this.notifier.eventsPosted--;
					if (!this.notifier.eventsPosted)
					{
						this.notifier.scanComplete = true;
						this.notifier.notifyListener(wnd, null, null);
					}

					this.notifier = null;
				}
			}
		};
		runnable.notifier = this;

		// Process each node in a separate event on current thread to allow other
		// events to process
		this.eventsPosted++;
		currentThread.dispatch(runnable, Ci.nsIEventTarget.DISPATCH_NORMAL);
	}
};

RequestNotifier.storeSelection = function(/**Window*/ wnd, /**String*/ selection)
{
	windowSelection.set(wnd, selection);
};
RequestNotifier.getSelection = function(/**Window*/ wnd) /**String*/
{
	if (windowSelection.has(wnd))
		return windowSelection.get(wnd);
	else
		return null;
};

/**
 * Attaches request data to a DOM node.
 * @param {Node} node   node to attach data to
 * @param {Window} topWnd   top-level window the node belongs to
 * @param {Integer} contentType   request type, one of the Policy.type.* constants
 * @param {String} docDomain  domain of the document that initiated the request
 * @param {Boolean} thirdParty  will be true if a third-party server has been requested
 * @param {String} location   the address that has been requested
 * @param {Filter} filter   filter applied to the request or null if none
 */
RequestNotifier.addNodeData = function(/**Node*/ node, /**Window*/ topWnd, /**Integer*/ contentType, /**String*/ docDomain, /**Boolean*/ thirdParty, /**String*/ location, /**Filter*/ filter)
{
	return new RequestEntry(node, topWnd, contentType, docDomain, thirdParty, location, filter);
}

/**
 * Retrieves the statistics for a window.
 * @result {Object} Object with the properties items, blocked, whitelisted, hidden, filters containing statistics for the window (might be null)
 */
RequestNotifier.getWindowStatistics = function(/**Window*/ wnd)
{
	if (windowStats.has(wnd.document))
		return windowStats.get(wnd.document);
	else
		return null;
}

/**
 * Retrieves the request entry associated with a DOM node.
 * @param {Node} node
 * @param {Boolean} noParent  if missing or false, the search will extend to the parent nodes until one is found that has data associated with it
 * @param {Integer} [type] request type to be looking for
 * @param {String} [location] request location to be looking for
 * @result {[Node, RequestEntry]}
 * @static
 */
RequestNotifier.getDataForNode = function(node, noParent, type, location)
{
	while (node)
	{
		let data = nodeData.get(node);
		if (typeof data != "undefined")
		{
			// Look for matching entry starting at the end of the list (most recent first)
			for (let i = data.length - 1; i >= 0; i--)
			{
				let entry = data[i];
				if ((typeof type == "undefined" || entry.type == type) &&
						(typeof location == "undefined" || entry.location == location))
				{
					return [node, entry];
				}
			}
		}

		// If we don't have any match on this node then maybe its parent will do
		if ((typeof noParent != "boolean" || !noParent) &&
				node.parentNode instanceof Ci.nsIDOMElement)
		{
			node = node.parentNode;
		}
		else
		{
			node = null;
		}
	}

	return null;
};

function RequestEntry(node, topWnd, contentType, docDomain, thirdParty, location, filter)
{
	this.type = contentType;
	this.docDomain = docDomain;
	this.thirdParty = thirdParty;
	this.location = location;
	this.filter = filter;

	this.attachToNode(node);

	// Update window statistics
	if (!windowStats.has(topWnd.document))
	{
		windowStats.set(topWnd.document, {
			items: 0,
			hidden: 0,
			blocked: 0,
			whitelisted: 0,
			filters: {}
		});
	}

	let stats = windowStats.get(topWnd.document);
	if (filter && filter instanceof ElemHideFilter)
		stats.hidden++;
	else
		stats.items++;
	if (filter)
	{
		if (filter instanceof BlockingFilter)
			stats.blocked++;
		else if (filter instanceof WhitelistFilter)
			stats.whitelisted++;

		if (filter.text in stats.filters)
			stats.filters[filter.text]++;
		else
			stats.filters[filter.text] = 1;
	}

	// Notify listeners
	for each (let notifier in activeNotifiers)
		if (!notifier.window || notifier.window == topWnd)
			notifier.notifyListener(topWnd, node, this);
}
RequestEntry.prototype =
{
	/**
	 * Content type of the request (one of the nsIContentPolicy constants)
	 * @type Integer
	 */
	type: null,
	/**
	 * Domain name of the requesting document
	 * @type String
	 */
	docDomain: null,
	/**
	 * True if the request goes to a different domain than the domain of the containing document
	 * @type Boolean
	 */
	thirdParty: false,
	/**
	 * Address being requested
	 * @type String
	 */
	location: null,
	/**
	 * Filter that was applied to this request (if any)
	 * @type Filter
	 */
	filter: null,
	/**
	 * String representation of the content type, e.g. "subdocument"
	 * @type String
	 */
	get typeDescr() Policy.typeDescr[this.type],
	/**
	 * User-visible localized representation of the content type, e.g. "frame"
	 * @type String
	 */
	get localizedDescr() Policy.localizedDescr[this.type],

	/**
	 * Attaches this request object to a DOM node.
	 */
	attachToNode: function(/**Node*/ node)
	{
		let existingData = nodeData.get(node);
		if (typeof existingData != "undefined")
		{
			// Add the new entry to the existing data
			existingData.push(this);
		}
		else
		{
			// Associate the node with a new array
			nodeData.set(node, [this]);
		}
	}
};
