const request = require("request");
const queryString  = require('query-string');

function getDateToday() {
    var today = new Date();
    today.setHours(0);
    today.setMinutes(0);
    today.setSeconds(0);
    today.setMilliseconds(0);
    return today;
}

function getAddressesForPostcode(postcode, callback) {
    request.get({
        url: 'https://refusecalendarapi.azurewebsites.net/address/search/?' + queryString.stringify({'postcode':postcode})        
    }, function(error, response, body) {
        if (error) {
            callback(error, null);
            return;
        }
        try {
            callback(null, JSON.parse(body));
        }
        catch (error) {
            callback(error, null);
        }
    });
}

var _streetSubstitutions = {
    "RD": "ROAD",
    "ST": "STREET",
    "AVE": "AVENUE",
    "AV": "AVENUE",
    "BLVD": "BOULEVARD",
    "PL": "PLACE",
    "DR": "DRIVE",
    "LN": "LANE",
    "GR": "GROVE",
    "CL": "CLOSE",
    "SQ": "SQUARE"
};
function normaliseStreetName(name) {
    name = name.trim().replace(/\s+/g, " ")
    name = name.toUpperCase();
    var nameParts = name.split();
    for (var i = 0; i < nameParts.length; i++) {
        if (_streetSubstitutions[nameParts[i]]) {
            nameParts[i] = _streetSubstitutions[nameParts[i]];
        }
    }
}

function lookupAddress(housenumber, street, postcode, callback) {
    // Normalise input
    housenumber = housenumber.toUpperCase();
    street = normaliseStreetName(street);
    postcode = postcode.toUpperCase();
    getAddressesForPostcode(postcode, function (err, addressList) {
        if (err) {
            callback(err, null);
            return;
        }
        // Check each entry for a match
        for (var i = 0; i < addressList.length; i++) {
            var item = addressList[i];
            if (item.houseNumber.toUpperCase() != housenumber) {
                continue;
            }
            if (normaliseStreetName(item.street) != street) {
                continue;
            }
            callback(null, item.id);
            return;
        }
        callback(null, null);
        return;
    });
}

function getSchedule(id, callback) {
    request.get({
        url: 'https://refusecalendarapi.azurewebsites.net/collection/search/' + id + '/?' + queryString.stringify({'numberOfCollections':10})        
    }, function(error, response, body) {
        if (error) {
            callback(error, null);
            return;
        }
        try {
            callback(null, JSON.parse(body));
        }
        catch (error) {
            callback(error, null);
        }
    });
}

var _binTypesCambridge = {
    "green":"ORGANIC",
    "blue":"RECYCLE",
    "black":"DOMESTIC"
};
var _binTypes = {"ORGANIC":"organic waste", "RECYCLE":"recycling", "DOMESTIC":"domestic waste"}
function collectionTypeForColor(color) {
    return _binTypesCambridge[color.toLowerCase()];
}

function nextCollection(schedule, collectionTypes, callback) {
    var dates = {};
    for (var i = 0; i < collectionTypes.length; i++) {
        var askedFor = collectionTypes[i];
        if (!_binTypes[collectionTypes[i]]) {
            // Maybe a color was provided?
            var c = collectionTypeForColor(collectionTypes[i]);
            if (c) {
                collectionTypes[i] = c;                
            }
            askedFor = askedFor + " bin";
        }
        else {
            askedFor = _binTypes[collectionTypes[i]];
        }
        dates[collectionTypes[i]] = {date:null, askedFor:askedFor};
    }
    
    if (!schedule || !schedule.collections) {
        callback("Missing collection data", null);
        return;
    }

    var today = getDateToday();
    for (var i = 0; i < schedule.collections.length; i++) {
        try {
            var collection = schedule.collections[i];
            if (!collection.roundTypes) {
                continue;
            }
            // Check if at least one of the collection types we're interested in is in this collection
            var found = [];
            for (var j = 0; j < collectionTypes.length; j++) {
                if (collection.roundTypes.indexOf(collectionTypes[j]) > -1) {
                    found.push(collectionTypes[j]);
                }
            }
            if (found.length == 0) {
                // Ignore this collection is it doesn't include the type of bin we're asking about
                continue;
            }

            // For each collection type of interest, see if this is the next one
            var cDate = new Date(collection.date); // TODO - check how timezone/DST is handled
            for (var j = 0; j < found.length; j++) {
                if (dates[found[j]].date && (cDate > dates[found[j]].date)) {
                    // Ignore this collection, we already know about an earlier one
                    continue;
                }
                if (cDate < today) {
                    // Ignore this collection, it's in the past
                    continue;
                }
                dates[found[j]].date = cDate;
            }
        }
        catch (error) {
            // should probably log this
        }
    }
    callback(null, dates);
}

var _line1RegExp = new RegExp(/^(\d+[a-zA-Z]*)[,]*\s+([a-zA-Z].*)/);
function parseAlexaAddress(address) {
    var housenumber = "(unknown)";
    var street = "(unknown)";
    var postcode = address.postalCode;
    var x = address.addressLine1.match(_line1RegExp);
    if (x && (x.length > 2)) {
        housenumber = x[1];
        street = x[2];
    }

    return {
        housenumber: housenumber,
        street: street,
        postcode: postcode
    };
}

function alexaSkillFulfillment(request, address, callback) {
    var collectionType = null;
    if (request.intent.slots && request.intent.slots.BinColor && request.intent.slots.BinColor.value) {
        collectionType = request.intent.slots.BinColor.value;
    }
    else if (request.intent.slots && request.intent.slots.BinType && request.intent.slots.BinType.value) {
        // We need to use the resolutions to get the canonical term used for the type of bin
        var slot = request.intent.slots.BinType;
        if (slot.resolutions && slot.resolutions.resolutionsPerAuthority) {
            if (slot.resolutions.resolutionsPerAuthority.length > 0) {
                var auth = slot.resolutions.resolutionsPerAuthority[0];
                if (auth.values && (auth.values.length > 0)) {
                    if (auth.values[0].value && auth.values[0].value.name) {
                        collectionType = auth.values[0].value.name;
                    }
                }
            }
        }
    }

    var hsp = parseAlexaAddress(address);
    if (!hsp) {
        callback("Sorry, I was unable to determine your address. Please check the council website for collection date.");
        return;
    }
    lookupAddress(hsp.housenumber, hsp.street, hsp.postcode, function(err, id) {
        if (err) {
            callback("Sorry, I was unable to find your address in the collection calendar. Please check the council website for collection date.");
            return;
        }
        getSchedule(id, function (err, schedule) {
            if (err) {
                callback("Sorry, I was unable to retrieve the collection calendar for your address. Please check the council website for collection date.");
                return;
            }
            var collectionTypes = [];
            if (collectionType) {
                collectionTypes.push(collectionType);
            }
            else {
                // Get the next date for each type of bin
                for (var ct in _binTypes) {
                    collectionTypes.push(ct);
                }
            }
            nextCollection(schedule, collectionTypes, function(err, dates) {
                if (err) {
                    callback("Sorry, I was unable to find the next date for the requested collection type. Please check the council website for collection date.");
                    return;
                }
                var today = getDateToday();
                var tomorrow = getDateToday();
                tomorrow.setDate(tomorrow.getDate() + 1);
                var txt = "";
                for (var ct in dates) {
                    txt += "The next " + dates[ct].askedFor + " collection is ";
                    if ((dates[ct].date - today) == 0) {
                        txt += "today";
                    }
                    else if ((dates[ct].date - tomorrow) == 0) {
                        txt += "tomorrow";
                    }
                    else {
                        if ((dates[ct].date - today) < (7*24*60*60*1000)) {
                            txt += "this coming ";
                        }
                        else {
                            txt += "on ";
                        }
                        txt += dates[ct].date.toLocaleString("en-GB", {weekday: 'short', month: 'long', day: 'numeric'});
                        var d = dates[ct].date.getDate();
                        if ((d == 1)||(d == 21)||(d == 31)) { txt += "st"; }
                        else if ((d == 2)||(d == 22)) { txt += "nd"; }
                        else if ((d == 3)||(d == 23)) { txt += "rd"; }
                        else { txt += "th"; }
                    }
                    txt += ". ";
                }
                callback(txt);
            });
        });
        
    });
}

function _test3() {
    var request = {
        intent: {
            slots: {
                BinColor:{
                    value:"black"
                }
            }
        }
    };
    var address = {
        addressLine1: "",
        postalCode: ""
    }
    alexaSkillFulfillment(request, address, function(say) {
        console.log("Saying: " + say);
    });
}

function _test2() {
    var data = {"collections":[{"date":"2018-11-28T00:00:00","roundTypes":["DOMESTIC"],"slippedCollection":false},{"date":"2018-12-05T00:00:00","roundTypes":["ORGANIC","RECYCLE"],"slippedCollection":false},{"date":"2018-12-12T00:00:00","roundTypes":["DOMESTIC"],"slippedCollection":false},{"date":"2018-12-19T00:00:00","roundTypes":["ORGANIC","RECYCLE"],"slippedCollection":false},{"date":"2018-12-27T00:00:00","roundTypes":["DOMESTIC"],"slippedCollection":true},{"date":"2019-01-03T00:00:00","roundTypes":["RECYCLE"],"slippedCollection":true},{"date":"2019-01-09T00:00:00","roundTypes":["DOMESTIC"],"slippedCollection":false},{"date":"2019-01-16T00:00:00","roundTypes":["ORGANIC","RECYCLE"],"slippedCollection":false},{"date":"2019-01-23T00:00:00","roundTypes":["DOMESTIC"],"slippedCollection":false},{"date":"2019-01-30T00:00:00","roundTypes":["RECYCLE"],"slippedCollection":false}],"roundTypes":["ORGANIC","DOMESTIC","RECYCLE"]};
    nextCollection(data, ["green","black","RECYCLE"], function(err, date) {
        if (err) {
            console.log("Error: " + err);
            return;
        }
        if (!date) {
            console.log("Not found.")
            return;
        }
        console.log(date);
    });
}

function _test() {
    var postcode = "";
    var housenumber = ""
    var street = "";

    console.log("Looking up " + housenumber + " " + street + ", " + postcode + "...");
    lookupAddress(housenumber, street, postcode, function(err, id) {
        if (err) {
            console.log("Error: " + err);
            return;
        }
        if (!id) {
            console.log("Not found.")
            return;
        }
        console.log("ID: " + id);
        getSchedule(id, function (err, data) {
            if (err) {
                console.log("Error: " + err);
                return;
            }
            console.log(JSON.stringify(data));
        });
    });
}

module.exports = {
    alexaSkillFulfillment: alexaSkillFulfillment
};
