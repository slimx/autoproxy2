/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

/**
 * @fileOverview FilterStorage class responsible to managing user's subscriptions and filters.
 */

var EXPORTED_SYMBOLS = ["FilterStorage"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

let baseURL = "chrome://autoproxy2-modules/content/";
Cu.import(baseURL + "Utils.jsm");
Cu.import(baseURL + "IO.jsm");
Cu.import(baseURL + "Prefs.jsm");
Cu.import(baseURL + "FilterClasses.jsm");
Cu.import(baseURL + "SubscriptionClasses.jsm");
Cu.import(baseURL + "FilterNotifier.jsm");
Cu.import(baseURL + "TimeLine.jsm");

/**
 * Version number of the filter storage file format.
 * @type Integer
 */
const formatVersion = 4;

/**
 * This class reads user's filters from disk, manages them in memory and writes them back.
 * @class
 */
var FilterStorage =
{
	/**
	 * Version number of the patterns.ini format used.
	 * @type Integer
	 */
	get formatVersion() formatVersion,

	/**
	 * File that the filter list has been loaded from and should be saved to
	 * @type nsIFile
	 */
	get sourceFile()
	{
		let file = null;
		if (Prefs.patternsfile)
		{
			// Override in place, use it instead of placing the file in the regular data dir
			file = IO.resolveFilePath(Prefs.patternsfile);
		}
		if (!file)
		{
			// Place the file in the data dir
			file = IO.resolveFilePath(Prefs.data_directory);
			if (file)
				file.append("patterns.ini");
		}
		if (!file)
		{
			// Data directory pref misconfigured? Try the default value
			try
			{
				file = IO.resolveFilePath(Prefs.defaultBranch.getCharPref("data_directory"));
				if (file)
					file.append("patterns.ini");
			} catch(e) {}
		}

		if (!file)
			Cu.reportError("Adblock Plus: Failed to resolve filter file location from extensions.autoproxy2.patternsfile preference");

		this.__defineGetter__("sourceFile", function() file);
		return this.sourceFile;
	},

	/**
	 * Map of properties listed in the filter storage file before the sections
	 * start. Right now this should be only the format version.
	 */
	fileProperties: {__proto__: null},

	/**
	 * List of filter subscriptions containing all filters
	 * @type Array of Subscription
	 */
	subscriptions: [],

	/**
	 * Map of subscriptions already on the list, by their URL/identifier
	 * @type Object
	 */
	knownSubscriptions: {__proto__: null},

	/**
	 * Finds the filter group that a filter should be added to by default. Will
	 * return null if this group doesn't exist yet.
	 */
	getGroupForFilter: function(/**Filter*/ filter) /**SpecialSubscription*/
	{
		let generalSubscription = null;
		for each (let subscription in FilterStorage.subscriptions)
		{
			if (subscription instanceof SpecialSubscription && !subscription.disabled)
			{
				// Always prefer specialized subscriptions
				if (subscription.isDefaultFor(filter))
					return subscription;

				// If this is a general subscription - store it as fallback
				if (!generalSubscription && (!subscription.defaults || !subscription.defaults.length))
					generalSubscription = subscription;
			}
		}
		return generalSubscription;
	},

	/**
	 * Adds a filter subscription to the list
	 * @param {Subscription} subscription filter subscription to be added
	 * @param {Boolean} silent  if true, no listeners will be triggered (to be used when filter list is reloaded)
	 */
	addSubscription: function(subscription, silent)
	{
		if (subscription.url in FilterStorage.knownSubscriptions)
			return;

		FilterStorage.subscriptions.push(subscription);
		FilterStorage.knownSubscriptions[subscription.url] = subscription;
		addSubscriptionFilters(subscription);

		if (!silent)
			FilterNotifier.triggerListeners("subscription.added", subscription);
	},

	/**
	 * Removes a filter subscription from the list
	 * @param {Subscription} subscription filter subscription to be removed
	 * @param {Boolean} silent  if true, no listeners will be triggered (to be used when filter list is reloaded)
	 */
	removeSubscription: function(subscription, silent)
	{
		for (let i = 0; i < FilterStorage.subscriptions.length; i++)
		{
			if (FilterStorage.subscriptions[i].url == subscription.url)
			{
				removeSubscriptionFilters(subscription);

				FilterStorage.subscriptions.splice(i--, 1);
				delete FilterStorage.knownSubscriptions[subscription.url];
				if (!silent)
					FilterNotifier.triggerListeners("subscription.removed", subscription);
				return;
			}
		}
	},

	/**
	 * Moves a subscription in the list to a new position.
	 * @param {Subscription} subscription filter subscription to be moved
	 * @param {Subscription} [insertBefore] filter subscription to insert before
	 *        (if omitted the subscription will be put at the end of the list)
	 */
	moveSubscription: function(subscription, insertBefore)
	{
		let currentPos = FilterStorage.subscriptions.indexOf(subscription);
		if (currentPos < 0)
			return;

		let newPos = insertBefore ? FilterStorage.subscriptions.indexOf(insertBefore) : -1;
		if (newPos < 0)
			newPos = FilterStorage.subscriptions.length;

		if (currentPos < newPos)
			newPos--;
		if (currentPos == newPos)
			return;

		FilterStorage.subscriptions.splice(currentPos, 1);
		FilterStorage.subscriptions.splice(newPos, 0, subscription);
		FilterNotifier.triggerListeners("subscription.moved", subscription);
	},

	/**
	 * Replaces the list of filters in a subscription by a new list
	 * @param {Subscription} subscription filter subscription to be updated
	 * @param {Array of Filter} filters new filter lsit
	 */
	updateSubscriptionFilters: function(subscription, filters)
	{
		removeSubscriptionFilters(subscription);
		subscription.oldFilters = subscription.filters;
		subscription.filters = filters;
		addSubscriptionFilters(subscription);
		FilterNotifier.triggerListeners("subscription.updated", subscription);
		delete subscription.oldFilters;

		// Do not keep empty subscriptions disabled
		if (subscription instanceof SpecialSubscription && !subscription.filters.length && subscription.disabled)
			subscription.disabled = false;
	},

	/**
	 * Adds a user-defined filter to the list
	 * @param {Filter} filter
	 * @param {SpecialSubscription} [subscription] particular group that the filter should be added to
	 * @param {Integer} [position] position within the subscription at which the filter should be added
	 * @param {Boolean} silent  if true, no listeners will be triggered (to be used when filter list is reloaded)
	 */
	addFilter: function(filter, subscription, position, silent)
	{
		if (!subscription)
		{
			if (filter.subscriptions.some(function(s) s instanceof SpecialSubscription && !s.disabled))
				return;   // No need to add
			subscription = FilterStorage.getGroupForFilter(filter);
		}
		if (!subscription)
		{
			// No group for this filter exists, create one
			subscription = SpecialSubscription.createForFilter(filter);
			this.addSubscription(subscription);
			return;
		}

		if (typeof position == "undefined")
			position = subscription.filters.length;

		if (filter.subscriptions.indexOf(subscription) < 0)
			filter.subscriptions.push(subscription);
		subscription.filters.splice(position, 0, filter);
		if (!silent)
			FilterNotifier.triggerListeners("filter.added", filter, subscription, position);
	},

	/**
	 * Removes a user-defined filter from the list
	 * @param {Filter} filter
	 * @param {SpecialSubscription} [subscription] a particular filter group that
	 *      the filter should be removed from (if ommited will be removed from all subscriptions)
	 * @param {Integer} [position]  position inside the filter group at which the
	 *      filter should be removed (if ommited all instances will be removed)
	 */
	removeFilter: function(filter, subscription, position)
	{
		let subscriptions = (subscription ? [subscription] : filter.subscriptions.slice());
		for (let i = 0; i < subscriptions.length; i++)
		{
			let subscription = subscriptions[i];
			if (subscription instanceof SpecialSubscription)
			{
				let positions = [];
				if (typeof position == "undefined")
				{
					let index = -1;
					do
					{
						index = subscription.filters.indexOf(filter, index + 1);
						if (index >= 0)
							positions.push(index);
					} while (index >= 0);
				}
				else
					positions.push(position);

				for (let j = positions.length - 1; j >= 0; j--)
				{
					let position = positions[j];
					if (subscription.filters[position] == filter)
					{
						subscription.filters.splice(position, 1);
						if (subscription.filters.indexOf(filter) < 0)
						{
							let index = filter.subscriptions.indexOf(subscription);
							if (index >= 0)
								filter.subscriptions.splice(index, 1);
						}
						FilterNotifier.triggerListeners("filter.removed", filter, subscription, position);
					}
				}
			}
		}
	},

	/**
	 * Moves a user-defined filter to a new position
	 * @param {Filter} filter
	 * @param {SpecialSubscription} subscription filter group where the filter is located
	 * @param {Integer} oldPosition current position of the filter
	 * @param {Integer} newPosition new position of the filter
	 */
	moveFilter: function(filter, subscription, oldPosition, newPosition)
	{
		if (!(subscription instanceof SpecialSubscription) || subscription.filters[oldPosition] != filter)
			return;

		newPosition = Math.min(Math.max(newPosition, 0), subscription.filters.length - 1);
		if (oldPosition == newPosition)
			return;

		subscription.filters.splice(oldPosition, 1);
		subscription.filters.splice(newPosition, 0, filter);
		FilterNotifier.triggerListeners("filter.moved", filter, subscription, oldPosition, newPosition);
	},

	/**
	 * Increases the hit count for a filter by one
	 * @param {Filter} filter
	 */
	increaseHitCount: function(filter)
	{
		if (!Prefs.savestats || Prefs.privateBrowsing || !(filter instanceof ActiveFilter))
			return;

		filter.hitCount++;
		filter.lastHit = Date.now();
	},

	/**
	 * Resets hit count for some filters
	 * @param {Array of Filter} filters  filters to be reset, if null all filters will be reset
	 */
	resetHitCounts: function(filters)
	{
		if (!filters)
		{
			filters = [];
			for each (let filter in Filter.knownFilters)
				filters.push(filter);
		}
		for each (let filter in filters)
		{
			filter.hitCount = 0;
			filter.lastHit = 0;
		}
	},

	_loading: false,

	/**
	 * Loads all subscriptions from the disk
	 * @param {nsIFile} [sourceFile] File to read from
	 */
	loadFromDisk: function(sourceFile)
	{
		if (this._loading)
			return;

		TimeLine.enter("Entered FilterStorage.loadFromDisk()");

		let explicitFile = true;
		if (!sourceFile)
		{
			sourceFile = FilterStorage.sourceFile;
			explicitFile = false;

			if (!sourceFile || !sourceFile.exists())
				sourceFile = Utils.makeURI("chrome://autoproxy2-defaults/content/patterns.ini");
		}

		let readFile = function(sourceFile, backupIndex)
		{
			TimeLine.enter("FilterStorage.loadFromDisk() -> readFile()");

			let parser = new INIParser();
			IO.readFromFile(sourceFile, true, parser, function(e)
			{
				TimeLine.enter("FilterStorage.loadFromDisk() read callback");
				if (!e && parser.subscriptions.length == 0)
				{
					// No filter subscriptions in the file, this isn't right.
					e = new Error("No data in the file");
				}

				if (e)
					Cu.reportError(e);

				if (e && !explicitFile)
				{
					// Attempt to load a backup
					sourceFile = this.sourceFile;
					if (sourceFile)
					{
						let [, part1, part2] = /^(.*)(\.\w+)$/.exec(sourceFile.leafName) || [null, sourceFile.leafName, ""];

						sourceFile = sourceFile.clone();
						sourceFile.leafName = part1 + "-backup" + (++backupIndex) + part2;

						if (sourceFile.exists())
						{
							readFile(sourceFile, backupIndex);
							TimeLine.leave("FilterStorage.loadFromDisk() read callback done");
							return;
						}
					}
				}

				// Old special groups might have been converted, remove them if they are empty
				let specialMap = {"~il~": true, "~wl~": true, "~fl~": true, "~eh~": true};
				let knownSubscriptions = {__proto__: null};
				for (let i = 0; i < parser.subscriptions.length; i++)
				{
					let subscription = parser.subscriptions[i];
					if (subscription instanceof SpecialSubscription && subscription.filters.length == 0 && subscription.url in specialMap)
						parser.subscriptions.splice(i--, 1);
					else
						knownSubscriptions[subscription.url] = subscription;
				}

				this.fileProperties = parser.fileProperties;
				this.subscriptions = parser.subscriptions;
				this.knownSubscriptions = knownSubscriptions;
				Filter.knownFilters = parser.knownFilters;
				Subscription.knownSubscriptions = parser.knownSubscriptions;

				if (parser.userFilters)
				{
					for (let i = 0; i < parser.userFilters.length; i++)
					{
						let filter = Filter.fromText(parser.userFilters[i]);
						if (filter)
							this.addFilter(filter, null, undefined, true);
					}
				}
				TimeLine.log("Initializing data done, triggering observers")

				this._loading = false;
				FilterNotifier.triggerListeners("load");

				if (sourceFile != this.sourceFile)
					this.saveToDisk();

				TimeLine.leave("FilterStorage.loadFromDisk() read callback done");
			}.bind(this), "FilterStorageRead");

			TimeLine.leave("FilterStorage.loadFromDisk() <- readFile()", "FilterStorageRead");
		}.bind(this);

		this._loading = true;
		readFile(sourceFile, 0);

		TimeLine.leave("FilterStorage.loadFromDisk() done");
	},

	_generateFilterData: function(subscriptions)
	{
		yield "# Adblock Plus preferences";
		yield "version=" + formatVersion;

		let saved = {__proto__: null};
		let buf = [];

		// Save filter data
		for (let i = 0; i < subscriptions.length; i++)
		{
			let subscription = subscriptions[i];
			for (let j = 0; j < subscription.filters.length; j++)
			{
				let filter = subscription.filters[j];
				if (!(filter.text in saved))
				{
					filter.serialize(buf);
					saved[filter.text] = filter;
					for (let k = 0; k < buf.length; k++)
						yield buf[k];
					buf.splice(0);
				}
			}
		}

		// Save subscriptions
		for (let i = 0; i < subscriptions.length; i++)
		{
			let subscription = subscriptions[i];

			yield "";

			subscription.serialize(buf);
			if (subscription.filters.length)
			{
				buf.push("", "[Subscription filters]")
				subscription.serializeFilters(buf);
			}
			for (let k = 0; k < buf.length; k++)
				yield buf[k];
			buf.splice(0);
		}
	},

	/**
	 * Will be set to true if saveToDisk() is running (reentrance protection).
	 * @type Boolean
	 */
	_saving: false,

	/**
	 * Will be set to true if a saveToDisk() call arrives while saveToDisk() is
	 * already running (delayed execution).
	 * @type Boolean
	 */
	_needsSave: false,

	/**
	 * Saves all subscriptions back to disk
	 * @param {nsIFile} [targetFile] File to be written
	 */
	saveToDisk: function(targetFile)
	{
		let explicitFile = true;
		if (!targetFile)
		{
			targetFile = FilterStorage.sourceFile;
			explicitFile = false;
		}
		if (!targetFile)
			return;

		if (!explicitFile && this._saving)
		{
			this._needsSave = true;
			return;
		}

		TimeLine.enter("Entered FilterStorage.saveToDisk()");

		try {
			targetFile.normalize();
		} catch (e) {}

		// Make sure the file's parent directory exists
		try {
			targetFile.parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
		} catch (e) {}

		let backupFileParts = null;
		if (!explicitFile && targetFile.exists() && Prefs.patternsbackups > 0)
		{
			// Check whether we need to backup the file
			let [, part1, part2] = /^(.*)(\.\w+)$/.exec(targetFile.leafName) || [null, targetFile.leafName, ""];

			let newestBackup = targetFile.clone();
			newestBackup.leafName = part1 + "-backup1" + part2;
			if (!newestBackup.exists() || (Date.now() - newestBackup.lastModifiedTime) / 3600000 >= Prefs.patternsbackupinterval)
				backupFileParts = [part1 + "-backup", part2];
		}

		let writeFilters = function()
		{
			TimeLine.enter("FilterStorage.saveToDisk() -> writeFilters()");
			IO.writeToFile(targetFile, true, this._generateFilterData(subscriptions), function(e)
			{
				TimeLine.enter("FilterStorage.saveToDisk() write callback");
				if (!explicitFile)
					this._saving = false;

				if (e)
					reportError(e);

				if (!explicitFile && this._needsSave)
				{
					this._needsSave = false;
					this.saveToDisk();
				}
				else
					FilterNotifier.triggerListeners("save");
				TimeLine.leave("FilterStorage.saveToDisk() write callback done");
			}.bind(this), "FilterStorageWrite");
			TimeLine.leave("FilterStorage.saveToDisk() -> writeFilters()", "FilterStorageWrite");
		}.bind(this);

		let removeLastBackup = function()
		{
			TimeLine.enter("FilterStorage.saveToDisk() -> removeLastBackup()");
			let file = targetFile.clone();
			file.leafName = backupFileParts.join(Prefs.patternsbackups);
			IO.removeFile(file, function(e) renameBackup(Prefs.patternsbackups - 1));
			TimeLine.leave("FilterStorage.saveToDisk() <- removeLastBackup()");
		}.bind(this);

		let renameBackup = function(index)
		{
			TimeLine.enter("FilterStorage.saveToDisk() -> renameBackup()");
			if (index > 0)
			{
				let fromFile = targetFile.clone();
				fromFile.leafName = backupFileParts.join(index);

				let toName = backupFileParts.join(index + 1);

				IO.renameFile(fromFile, toName, function(e) renameBackup(index - 1));
			}
			else
			{
				let toFile = targetFile.clone();
				toFile.leafName = backupFileParts.join(index + 1);

				IO.copyFile(targetFile, toFile, writeFilters);
			}
			TimeLine.leave("FilterStorage.saveToDisk() <- renameBackup()");
		}.bind(this);

		// Do not persist external subscriptions
		let subscriptions = this.subscriptions.filter(function(s) !(s instanceof ExternalSubscription));
		if (!explicitFile)
			this._saving = true;

		if (backupFileParts)
			removeLastBackup();
		else
			writeFilters();

		TimeLine.leave("FilterStorage.saveToDisk() done");
	},

	/**
	 * Returns the list of existing backup files.
	 */
	getBackupFiles: function() /**nsIFile[]*/
	{
		let result = [];

		let [, part1, part2] = /^(.*)(\.\w+)$/.exec(FilterStorage.sourceFile.leafName) || [null, FilterStorage.sourceFile.leafName, ""];
		for (let i = 1; ; i++)
		{
			let file = FilterStorage.sourceFile.clone();
			file.leafName = part1 + "-backup" + i + part2;
			if (file.exists())
				result.push(file);
			else
				break;
		}
		return result;
	}
};

/**
 * Joins subscription's filters to the subscription without any notifications.
 * @param {Subscription} subscription filter subscription that should be connected to its filters
 */
function addSubscriptionFilters(subscription)
{
	if (!(subscription.url in FilterStorage.knownSubscriptions))
		return;

	for each (let filter in subscription.filters)
		filter.subscriptions.push(subscription);
}

/**
 * Removes subscription's filters from the subscription without any notifications.
 * @param {Subscription} subscription filter subscription to be removed
 */
function removeSubscriptionFilters(subscription)
{
	if (!(subscription.url in FilterStorage.knownSubscriptions))
		return;

	for each (let filter in subscription.filters)
	{
		let i = filter.subscriptions.indexOf(subscription);
		if (i >= 0)
			filter.subscriptions.splice(i, 1);
	}
}

/**
 * IO.readFromFile() listener to parse filter data.
 */
function INIParser()
{
	this.fileProperties = this.curObj = {};
	this.subscriptions = [];
	this.knownFilters = {__proto__: null};
	this.knownSubscriptions = {__proto__: null};
}
INIParser.prototype =
{
	subscriptions: null,
	knownFilters: null,
	knownSubscrptions : null,
	wantObj: true,
	fileProperties: null,
	curObj: null,
	curSection: null,
	userFilters: null,

	process: function(val)
	{
		let origKnownFilters = Filter.knownFilters;
		Filter.knownFilters = this.knownFilters;
		let origKnownSubscriptions = Subscription.knownSubscriptions;
		Subscription.knownSubscriptions = this.knownSubscriptions;
		let match;
		try
		{
			if (this.wantObj === true && (match = /^(\w+)=(.*)$/.exec(val)))
				this.curObj[match[1]] = match[2];
			else if (val === null || (match = /^\s*\[(.+)\]\s*$/.exec(val)))
			{
				if (this.curObj)
				{
					// Process current object before going to next section
					switch (this.curSection)
					{
						case "filter":
						case "pattern":
							if ("text" in this.curObj)
								Filter.fromObject(this.curObj);
							break;
						case "subscription":
							let subscription = Subscription.fromObject(this.curObj);
							if (subscription)
								this.subscriptions.push(subscription);
							break;
						case "subscription filters":
						case "subscription patterns":
							if (this.subscriptions.length)
							{
								let subscription = this.subscriptions[this.subscriptions.length - 1];
								for each (let text in this.curObj)
								{
									let filter = Filter.fromText(text);
									if (filter)
									{
										subscription.filters.push(filter);
										filter.subscriptions.push(subscription);
									}
								}
							}
							break;
						case "user patterns":
							this.userFilters = this.curObj;
							break;
					}
				}

				if (val === null)
					return;

				this.curSection = match[1].toLowerCase();
				switch (this.curSection)
				{
					case "filter":
					case "pattern":
					case "subscription":
						this.wantObj = true;
						this.curObj = {};
						break;
					case "subscription filters":
					case "subscription patterns":
					case "user patterns":
						this.wantObj = false;
						this.curObj = [];
						break;
					default:
						this.wantObj = undefined;
						this.curObj = null;
				}
			}
			else if (this.wantObj === false && val)
				this.curObj.push(val.replace(/\\\[/g, "["));
		}
		finally
		{
			Filter.knownFilters = origKnownFilters;
			Subscription.knownSubscriptions = origKnownSubscriptions;
		}
	}
};
