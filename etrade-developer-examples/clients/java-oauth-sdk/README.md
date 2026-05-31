# E\*TRADE OAuth SDK Guide

## Introduction

The E\*TRADE Developer Platform uses the OAuth 1.0a Open Authentication protocol. This library provides the
necessary authorization functionality. Note: the full implementation for the OAuth SDK is from the sample
Java client ([`https://developer.etrade.com/support/downloads`](https://developer.etrade.com/support/downloads)).

## How to Install the E\*TRADE Java OAuth SDK

The E*TRADE Java SDK requires JDK 1.8. The SDK requires that the E*TRADE OAuth JAR be present and included
in the CLASSPATH. You can download the E*TRADE Java SDK from the E*TRADE developer website,
[`https://developer.etrade.com/support/downloads`](https://developer.etrade.com/support/downloads).

## E\*TRADE Java Methods

This table lists the methods provided by the E\*TRADE Java OAuth SDK.

| Class           |      Method      | Description                                                                                                                                 |
| --------------- | :--------------: | :------------------------------------------------------------------------------------------------------------------------------------------ |
| AppController   |      invoke      | Returns response invoking the API call                                                                                                      |
| SecurityContext |   getResources   | Retrieve resources to set consumer key and consumer secret                                                                                  |
| Resource        |  setConsumerKey  | Sets consumer key                                                                                                                           |
|                 | setSharedSecret  | Sets consumer secret                                                                                                                        |
| Message         | setOauthRequired | Set if OAuth is required. Mainly used for Quotes API if customer does not want to go through the OAuth process for receiving delayed quotes |
|                 |  setHttpMethod   | Sets HTTP method for API call                                                                                                               |
|                 |      setUrl      | Sets URL for API call                                                                                                                       |
|                 |  setContentType  | Sets ContentType for API call                                                                                                               |

This table lists the Enums used by the message class.

| Enum          |                  Enum Types                   | Description                           |
| ------------- | :-------------------------------------------: | :------------------------------------ |
| OauthRequired |                    YES, NO                    | Enum used for setOauthRequired method |
| ContentType   | APPLICATION_FORM_URLENCODED, APPLICATION_JSON | Enum used for setContentType method   |

## Example: Using the OAuth E\*TRADE SDK to Call Account List API

Here is more information about these four steps shown in the example code:

1. Inject Spring bean dependencies from OOauthConfig class
2. Set consumer key and consumer secret
3. Create Message object and set variables
4. Invoke the API and return the response

###Step One: Initialize spring context for the OAuth process.

```
ctx = new AnnotationConfigApplicationContext();
ctx.register(OOauthConfig.class);
ctx.refresh();
```

###Step Two: Set consumer key and consumer secret.

```
SecurityContext securityContext = ctx.getBean(SecurityContext.class);
Resource resource = securityContext.getResouces();
resource.setConsumerKey("XXXXXXXXXXXXXXXXXXXXXXXXXXX ");
resource.setSharedSecret("XXXXXXXXXXXXXXXXXXXXXXXXXXX");
```

###Step Three: Create the Message object and set these variables: HttpMethod, API Url, contentType, and OauthRequired.

```
Message messageAccountList = new Message();
messageAccountList.setOauthRequired(OauthRequired.YES);
messageAccountList.setHttpMethod("GET");
messageAccountList.setUrl("https://api.uat.etrade.com/v1/accounts/list");
messageAccountList.setContentType(ContentType.APPLICATION_JSON);
```

###Step Four: Invoke the API call and return the response.

```
AppController appController = ctx.getBean(AppController.class);
String response = appController.invoke(messageAccountList);
```

## For More Information

For more information about other API calls, refer to the documentation page and Java example application available at
our developer site: [` https://developer.etrade.com/home`](https://developer.etrade.com/home).
