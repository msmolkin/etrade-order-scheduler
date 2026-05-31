import com.etrade.exampleapp.config.OOauthConfig;
import com.etrade.exampleapp.v1.oauth.AppController;
import com.etrade.exampleapp.v1.oauth.model.*;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

public class OAuthSDKSample {

    AnnotationConfigApplicationContext ctx = null;

    public static void main(String[] args) {
        OAuthSDKSample client = new OAuthSDKSample();
        client.run();

    }

    public void run(){
        //Step 1:  Initialize spring context for the OAuth process.
        ctx = new AnnotationConfigApplicationContext();
        ctx.register(OOauthConfig.class);
        ctx.refresh();

        try {
            String response = "";

            //Step 2:  Set Consumer Key and Consumer Secret.
            SecurityContext securityContext = ctx.getBean(SecurityContext.class);
            Resource resource = securityContext.getResources();
            resource.setConsumerKey("ENTER_CONSUMER_KEY_HERE");
            resource.setSharedSecret("ENTER_CONSUMER_SECRET_HERE");


            //Step 3: This is how to create the Message object and set HttpMethod, API Url, contentType, and OauthRequired.
            Message messageAccountList = new Message();
            messageAccountList.setOauthRequired(OauthRequired.YES);
            messageAccountList.setHttpMethod("GET");
            messageAccountList.setUrl("https://api.etrade.com/v1/accounts/list");
            messageAccountList.setContentType(ContentType.APPLICATION_JSON);

            //Step 4: This is how to invoke the API call and return the response.
            AppController appController = ctx.getBean(AppController.class);
            response = appController.invoke(messageAccountList);
            System.out.println(response.toString());

        } catch(Exception ex) {
            ex.printStackTrace();
        }
    }
}